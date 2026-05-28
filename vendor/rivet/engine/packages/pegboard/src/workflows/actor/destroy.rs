use futures_util::TryStreamExt;
use gas::prelude::*;
use rivet_data::converted::ActorByKeyKeyData;
use rivet_runner_protocol::PROTOCOL_MK1_VERSION;
use universaldb::options::{ConflictRangeType, MutationType, StreamingMode};
use universaldb::utils::IsolationLevel::*;

use super::{DestroyComplete, DestroyStarted, State};

use crate::{
	executor::{
		RunnerAllocIndexKey, WorkerLane, actor_placement_key, alloc_bucket_for_placement_key,
		bucket_remaining_millislots, worker_lane_from_hint,
	},
	keys,
	routing_directory::{RoutingDelta, publish_delta_best_effort},
};

#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Input {
	pub namespace_id: Id,
	pub actor_id: Id,
	pub name: String,
	pub key: Option<String>,
	pub generation: u32,
}

#[workflow]
pub(crate) async fn pegboard_actor_destroy(ctx: &mut WorkflowCtx, input: &Input) -> Result<()> {
	ctx.msg(DestroyStarted {})
		.topic(("actor_id", input.actor_id))
		.send()
		.await?;

	let ups = ctx.ups()?;
	publish_delta_best_effort(
		&ups,
		RoutingDelta::Removed {
			actor_id: input.actor_id,
			generation: u64::MAX,
		},
	)
	.await;

	let res = ctx
		.activity(UpdateStateAndDbInput {
			actor_id: input.actor_id,
		})
		.await?;

	// If a slot was allocated at the time of actor destruction then bump the runner pool so it can scale down
	// if needed
	if res.allocated_serverless_slot {
		ctx.removed::<Message<super::BumpServerlessAutoscalerStub>>()
			.await?;

		let bump_res = ctx
			.v(2)
			.signal(crate::workflows::runner_pool::Bump::default())
			.to_workflow::<crate::workflows::runner_pool::Workflow>()
			.tag("namespace_id", input.namespace_id)
			.tag("runner_name", res.runner_name_selector.clone())
			.send()
			.await;

		if let Some(WorkflowError::WorkflowNotFound) = bump_res
			.as_ref()
			.err()
			.and_then(|x| x.chain().find_map(|x| x.downcast_ref::<WorkflowError>()))
		{
			tracing::warn!(
				namespace_id=%input.namespace_id,
				runner_name=%res.runner_name_selector,
				"serverless pool workflow not found, runner config likely deleted"
			);
		} else {
			bump_res?;
		}
	}

	// Clear KV
	ctx.activity(ClearKvInput {
		actor_id: input.actor_id,
	})
	.await?;

	ctx.msg(DestroyComplete {})
		.topic(("actor_id", input.actor_id))
		.send()
		.await?;

	Ok(())
}

#[derive(Debug, Serialize, Deserialize, Hash)]
struct UpdateStateAndDbInput {
	actor_id: Id,
}

#[derive(Debug, Serialize, Deserialize, Hash)]
struct UpdateStateAndDbOutput {
	allocated_serverless_slot: bool,
	runner_name_selector: String,
}

#[activity(UpdateStateAndDb)]
async fn update_state_and_db(
	ctx: &ActivityCtx,
	input: &UpdateStateAndDbInput,
) -> Result<UpdateStateAndDbOutput> {
	let mut state = ctx.state::<State>()?;
	let destroy_ts = util::timestamp::now();

	let runner_id = state.runner_id;
	let namespace_id = state.namespace_id;
	let runner_name_selector = &state.runner_name_selector;
	let allocated_serverless_slot = state.allocated_serverless_slot;
	let name = &state.name;
	let create_ts = state.create_ts;
	let key = &state.key;
	ctx.udb()?
		.run(|tx| {
			async move {
				let tx = tx.with_subspace(keys::subspace());
				let total_actors_metric_incremented_key =
					keys::actor::TotalActorsMetricIncrementedKey::new(input.actor_id);
				let total_actors_metric_incremented = tx
					.exists(&total_actors_metric_incremented_key, Serializable)
					.await?;

				tx.write(&keys::actor::DestroyTsKey::new(input.actor_id), destroy_ts)?;

				clear_slot(
					input.actor_id,
					namespace_id,
					name,
					key.as_deref(),
					runner_name_selector,
					runner_id,
					allocated_serverless_slot,
					&tx,
				)
				.await?;

				// Update namespace indexes
				tx.delete(&keys::ns::ActiveActorKey::new(
					namespace_id,
					name.clone(),
					create_ts,
					input.actor_id,
				));

				if let Some(key) = &key {
					tx.write(
						&keys::ns::ActorByKeyKey::new(
							namespace_id,
							name.clone(),
							key.clone(),
							create_ts,
							input.actor_id,
						),
						ActorByKeyKeyData {
							workflow_id: ctx.workflow_id(),
							is_destroyed: true,
						},
					)?;
				}

				// Update metrics only if the delayed metrics workflow incremented the counter.
				if total_actors_metric_incremented {
					namespace::keys::metric::inc(
						&tx.with_subspace(namespace::keys::subspace()),
						namespace_id,
						namespace::keys::metric::Metric::TotalActors(name.clone()),
						-1,
					);
					tx.delete(&total_actors_metric_incremented_key);
				}

				Ok(())
			}
		})
		.custom_instrument(tracing::info_span!("actor_destroy_tx"))
		.await?;

	state.destroy_ts = Some(destroy_ts);
	state.runner_id = None;

	let old_allocated_serverless_slot = state.allocated_serverless_slot;
	state.allocated_serverless_slot = false;

	Ok(UpdateStateAndDbOutput {
		allocated_serverless_slot: old_allocated_serverless_slot,
		runner_name_selector: state.runner_name_selector.clone(),
	})
}

#[derive(Debug, Serialize, Deserialize, Hash)]
struct ClearKvInput {
	actor_id: Id,
}

#[derive(Debug, Serialize, Deserialize, Hash)]
struct ClearKvOutput {
	// Simply an estimate, not accurate under 3MiB
	final_size: i64,
}

#[activity(ClearKv)]
async fn clear_kv(ctx: &ActivityCtx, input: &ClearKvInput) -> Result<ClearKvOutput> {
	let final_size = ctx
		.udb()?
		.run(|tx| async move {
			let subspace = keys::actor_kv::subspace(input.actor_id);

			let (start, end) = subspace.range();
			let final_size = tx.get_estimated_range_size_bytes(&start, &end).await?;

			// Matches `delete_all` from actor kv
			tx.clear_subspace_range(&subspace);
			crate::actor_sqlite::clear_v2_storage_for_destroy(&tx, input.actor_id);

			Ok(final_size)
		})
		.custom_instrument(tracing::info_span!("actor_clear_kv_tx"))
		.await?;

	Ok(ClearKvOutput { final_size })
}

pub(crate) async fn clear_slot(
	actor_id: Id,
	namespace_id: Id,
	name: &str,
	key: Option<&str>,
	runner_name_selector: &str,
	runner_id: Option<Id>,
	allocated_serverless_slot: bool,
	tx: &universaldb::Transaction,
) -> Result<()> {
	let tx = tx.with_subspace(keys::subspace());

	// Only clear slot if we have a runner id
	if let Some(runner_id) = runner_id {
		tx.delete(&keys::actor::RunnerIdKey::new(actor_id));

		// This is cleared when the state changes as well as when the actor is destroyed to ensure
		// consistency during rescheduling and forced deletion.
		tx.delete(&keys::runner::ActorKey::new(runner_id, actor_id));

		let runner_workflow_id_key = keys::runner::WorkflowIdKey::new(runner_id);
		let runner_version_key = keys::runner::VersionKey::new(runner_id);
		let runner_remaining_slots_key = keys::runner::RemainingSlotsKey::new(runner_id);
		let runner_total_slots_key = keys::runner::TotalSlotsKey::new(runner_id);
		let runner_last_ping_ts_key = keys::runner::LastPingTsKey::new(runner_id);
		let runner_protocol_version_key = keys::runner::ProtocolVersionKey::new(runner_id);
		let runner_lane_key = keys::runner::LaneKey::new(runner_id);

		let (
			runner_workflow_id,
			runner_version,
			runner_remaining_slots,
			runner_total_slots,
			runner_last_ping_ts,
			runner_protocol_version,
			runner_lane,
		) = tokio::try_join!(
			tx.read(&runner_workflow_id_key, Serializable),
			tx.read(&runner_version_key, Serializable),
			tx.read(&runner_remaining_slots_key, Serializable),
			tx.read(&runner_total_slots_key, Serializable),
			tx.read(&runner_last_ping_ts_key, Serializable),
			tx.read_opt(&runner_protocol_version_key, Serializable),
			tx.read_opt(&runner_lane_key, Serializable),
		)?;
		let worker_lane = worker_lane_from_hint(runner_lane.as_deref());

		let placement_key = actor_placement_key(namespace_id, name, key, actor_id);
		let allocation_bucket = alloc_bucket_for_placement_key(&placement_key);
		let mut released_bucket_slot = false;

		if worker_lane == WorkerLane::default() {
			let runner_alloc_subspace =
				keys::subspace().subspace(&keys::ns::RunnerAllocBucketIdxKey::subspace(
					namespace_id,
					runner_name_selector.to_string(),
					allocation_bucket,
				));
			let mut stream = tx.get_ranges_keyvalues(
				universaldb::RangeOption {
					mode: StreamingMode::Iterator,
					..(&runner_alloc_subspace).into()
				},
				Snapshot,
			);

			while let Some(entry) = stream.try_next().await? {
				let (old_bucket_key, old_bucket_data) =
					tx.read_entry::<keys::ns::RunnerAllocBucketIdxKey>(&entry)?;
				if old_bucket_key.runner_id != runner_id {
					continue;
				}

				tx.add_conflict_key(&old_bucket_key, ConflictRangeType::Read)?;
				tx.delete(&old_bucket_key);

				let new_bucket_remaining_slots = old_bucket_data
					.remaining_slots
					.saturating_add(1)
					.min(old_bucket_data.total_slots);
				let new_bucket_remaining_millislots = bucket_remaining_millislots(
					new_bucket_remaining_slots,
					old_bucket_data.total_slots,
				);
				tx.write(
					&keys::ns::RunnerAllocBucketIdxKey::new(
						namespace_id,
						runner_name_selector.to_string(),
						allocation_bucket,
						old_bucket_key.version,
						new_bucket_remaining_millislots,
						old_bucket_key.last_ping_ts,
						runner_id,
					),
					rivet_data::converted::RunnerAllocIdxKeyData {
						workflow_id: runner_workflow_id,
						remaining_slots: new_bucket_remaining_slots,
						total_slots: old_bucket_data.total_slots,
						protocol_version: runner_protocol_version.unwrap_or(PROTOCOL_MK1_VERSION),
					},
				)?;
				released_bucket_slot = true;
				break;
			}
		} else {
			let runner_alloc_subspace =
				keys::subspace().subspace(&keys::ns::RunnerLaneAllocBucketIdxKey::subspace(
					namespace_id,
					runner_name_selector.to_string(),
					worker_lane.as_str().to_owned(),
					allocation_bucket,
				));
			let mut stream = tx.get_ranges_keyvalues(
				universaldb::RangeOption {
					mode: StreamingMode::Iterator,
					..(&runner_alloc_subspace).into()
				},
				Snapshot,
			);

			while let Some(entry) = stream.try_next().await? {
				let (old_bucket_key, old_bucket_data) =
					tx.read_entry::<keys::ns::RunnerLaneAllocBucketIdxKey>(&entry)?;
				if old_bucket_key.runner_id != runner_id {
					continue;
				}

				tx.add_conflict_key(&old_bucket_key, ConflictRangeType::Read)?;
				tx.delete(&old_bucket_key);

				let new_bucket_remaining_slots = old_bucket_data
					.remaining_slots
					.saturating_add(1)
					.min(old_bucket_data.total_slots);
				let new_bucket_remaining_millislots = bucket_remaining_millislots(
					new_bucket_remaining_slots,
					old_bucket_data.total_slots,
				);
				tx.write(
					&keys::ns::RunnerLaneAllocBucketIdxKey::new(
						namespace_id,
						runner_name_selector.to_string(),
						worker_lane.as_str().to_owned(),
						allocation_bucket,
						old_bucket_key.version,
						new_bucket_remaining_millislots,
						old_bucket_key.last_ping_ts,
						runner_id,
					),
					rivet_data::converted::RunnerAllocIdxKeyData {
						workflow_id: runner_workflow_id,
						remaining_slots: new_bucket_remaining_slots,
						total_slots: old_bucket_data.total_slots,
						protocol_version: runner_protocol_version.unwrap_or(PROTOCOL_MK1_VERSION),
					},
				)?;
				released_bucket_slot = true;
				break;
			}
		}

		if !released_bucket_slot {
			let old_runner_remaining_millislots =
				(runner_remaining_slots * 1000) / runner_total_slots;
			let new_runner_remaining_slots = runner_remaining_slots + 1;

			// Write new remaining slots
			tx.write(&runner_remaining_slots_key, new_runner_remaining_slots)?;

			let old_runner_alloc_key = keys::ns::RunnerAllocIdxKey::new(
				namespace_id,
				runner_name_selector.to_string(),
				runner_version,
				old_runner_remaining_millislots,
				runner_last_ping_ts,
				runner_id,
			);
			let old_runner_lane_alloc_key = keys::ns::RunnerLaneAllocIdxKey::new(
				namespace_id,
				runner_name_selector.to_string(),
				worker_lane.as_str().to_owned(),
				runner_version,
				old_runner_remaining_millislots,
				runner_last_ping_ts,
				runner_id,
			);

			// Only update allocation idx if it existed before
			let (old_runner_alloc_exists, old_runner_lane_alloc_exists) = tokio::try_join!(
				tx.exists(&old_runner_alloc_key, Serializable),
				tx.exists(&old_runner_lane_alloc_key, Serializable),
			)?;
			let old_runner_index_key = if old_runner_lane_alloc_exists {
				Some(RunnerAllocIndexKey::Lane(old_runner_lane_alloc_key))
			} else if old_runner_alloc_exists {
				Some(RunnerAllocIndexKey::Default(old_runner_alloc_key))
			} else {
				None
			};

			if let Some(old_runner_index_key) = old_runner_index_key {
				// Clear old key
				match &old_runner_index_key {
					RunnerAllocIndexKey::Default(key) => tx.delete(key),
					RunnerAllocIndexKey::Lane(key) => tx.delete(key),
					RunnerAllocIndexKey::BucketDefault(_) | RunnerAllocIndexKey::BucketLane(_) => {
						unreachable!("legacy slot release cannot select a bucket index")
					}
				}

				let new_remaining_millislots =
					(new_runner_remaining_slots * 1000) / runner_total_slots;
				let new_runner_index_key = match old_runner_index_key {
					RunnerAllocIndexKey::Default(_) => {
						RunnerAllocIndexKey::Default(keys::ns::RunnerAllocIdxKey::new(
							namespace_id,
							runner_name_selector.to_string(),
							runner_version,
							new_remaining_millislots,
							runner_last_ping_ts,
							runner_id,
						))
					}
					RunnerAllocIndexKey::Lane(_) => {
						RunnerAllocIndexKey::Lane(keys::ns::RunnerLaneAllocIdxKey::new(
							namespace_id,
							runner_name_selector.to_string(),
							worker_lane.as_str().to_owned(),
							runner_version,
							new_remaining_millislots,
							runner_last_ping_ts,
							runner_id,
						))
					}
					RunnerAllocIndexKey::BucketDefault(_) | RunnerAllocIndexKey::BucketLane(_) => {
						unreachable!("legacy slot release cannot select a bucket index")
					}
				};

				let alloc_data = rivet_data::converted::RunnerAllocIdxKeyData {
					workflow_id: runner_workflow_id,
					remaining_slots: new_runner_remaining_slots,
					total_slots: runner_total_slots,
					// We default here because its not important for mk1 protocol runners
					protocol_version: runner_protocol_version.unwrap_or(PROTOCOL_MK1_VERSION),
				};
				match new_runner_index_key {
					RunnerAllocIndexKey::Default(key) => tx.write(&key, alloc_data)?,
					RunnerAllocIndexKey::Lane(key) => tx.write(&key, alloc_data)?,
					RunnerAllocIndexKey::BucketDefault(_) | RunnerAllocIndexKey::BucketLane(_) => {
						unreachable!("legacy slot release cannot select a bucket index")
					}
				}
			}
		}
	}

	if allocated_serverless_slot {
		// Clear the serverless slot even if we do not have a runner id. This happens when the
		// actor is destroyed while pending allocation
		tx.atomic_op(
			&rivet_types::keys::pegboard::ns::ServerlessDesiredSlotsKey::new(
				namespace_id,
				runner_name_selector.to_string(),
			),
			&(-1i64).to_le_bytes(),
			MutationType::Add,
		);
	}

	Ok(())
}
