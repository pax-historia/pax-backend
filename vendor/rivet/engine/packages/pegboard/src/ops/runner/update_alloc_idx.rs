use futures_util::TryStreamExt;
use gas::prelude::*;
use rivet_runner_protocol::PROTOCOL_MK1_VERSION;
use universaldb::options::ConflictRangeType;
use universaldb::options::StreamingMode;
use universaldb::utils::IsolationLevel::*;

use crate::{
	executor::{
		ALLOC_INDEX_BUCKET_COUNT, WorkerLane, bucket_remaining_millislots, bucket_remaining_slots,
		bucket_slot_capacity, worker_lane_from_hint,
	},
	keys,
};

#[derive(Debug)]
pub struct Input {
	pub runners: Vec<Runner>,
}

#[derive(Debug, Clone)]
pub struct Runner {
	pub runner_id: Id,
	pub action: Action,
}

#[derive(Debug, Copy, Clone)]
pub enum Action {
	ClearIdx,
	AddIdx,
	UpdatePing { rtt: u32 },
}

#[derive(Debug)]
pub struct Output {
	// Inform the caller of certain runner eligibility changes they should know about.
	pub notifications: Vec<RunnerNotification>,
}

#[derive(Debug)]
pub struct RunnerNotification {
	pub runner_id: Id,
	pub workflow_id: Id,
	pub eligibility: RunnerEligibility,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunnerEligibility {
	// The runner that was just updated is now eligible again for allocation.
	ReEligible,
	// The runner that was just updated is expired.
	Expired,
}

#[operation]
pub async fn pegboard_runner_update_alloc_idx(ctx: &OperationCtx, input: &Input) -> Result<Output> {
	let runner_eligible_threshold = ctx.config().pegboard().runner_eligible_threshold();

	let notifications = ctx
		.udb()?
		.run(|tx| {
			let runners = input.runners.clone();

			async move {
				let tx = tx.with_subspace(keys::subspace());
				let mut notifications = Vec::new();

				// TODO: Parallelize
				for runner in &runners {
					let workflow_id_key = keys::runner::WorkflowIdKey::new(runner.runner_id);
					let namespace_id_key = keys::runner::NamespaceIdKey::new(runner.runner_id);
					let name_key = keys::runner::NameKey::new(runner.runner_id);
					let version_key = keys::runner::VersionKey::new(runner.runner_id);
					let remaining_slots_key =
						keys::runner::RemainingSlotsKey::new(runner.runner_id);
					let total_slots_key = keys::runner::TotalSlotsKey::new(runner.runner_id);
					let lane_key = keys::runner::LaneKey::new(runner.runner_id);
					let protocol_version_key =
						keys::runner::ProtocolVersionKey::new(runner.runner_id);
					let last_ping_ts_key = keys::runner::LastPingTsKey::new(runner.runner_id);
					let drain_ts_key = keys::runner::DrainTsKey::new(runner.runner_id);
					let expired_ts_key = keys::runner::ExpiredTsKey::new(runner.runner_id);

					let (
						workflow_id_entry,
						namespace_id_entry,
						name_entry,
						version_entry,
						remaining_slots_entry,
						total_slots_entry,
						lane_entry,
						protocol_version_entry,
						last_ping_ts_entry,
						draining,
						expired,
					) = tokio::try_join!(
						tx.read_opt(&workflow_id_key, Serializable),
						tx.read_opt(&namespace_id_key, Serializable),
						tx.read_opt(&name_key, Serializable),
						tx.read_opt(&version_key, Serializable),
						tx.read_opt(&remaining_slots_key, Serializable),
						tx.read_opt(&total_slots_key, Serializable),
						tx.read_opt(&lane_key, Serializable),
						tx.read_opt(&protocol_version_key, Serializable),
						tx.read_opt(&last_ping_ts_key, Serializable),
						tx.exists(&drain_ts_key, Serializable),
						tx.exists(&expired_ts_key, Serializable),
					)?;

					let (
						Some(workflow_id),
						Some(namespace_id),
						Some(name),
						Some(version),
						Some(remaining_slots),
						Some(total_slots),
						Some(old_last_ping_ts),
					) = (
						workflow_id_entry,
						namespace_id_entry,
						name_entry,
						version_entry,
						remaining_slots_entry,
						total_slots_entry,
						last_ping_ts_entry,
					)
					else {
						tracing::debug!(runner_id=?runner.runner_id, "runner has not initiated yet");
						continue;
					};

					let protocol_version = protocol_version_entry.unwrap_or(PROTOCOL_MK1_VERSION);
					let worker_lane = worker_lane_from_hint(lane_entry.as_deref());

					// Runner is expired, AddIdx is invalid and UpdatePing will do nothing
					if expired {
						match runner.action {
							Action::ClearIdx => {}
							Action::AddIdx | Action::UpdatePing { .. } => {
								notifications.push(RunnerNotification {
									runner_id: runner.runner_id,
									workflow_id,
									eligibility: RunnerEligibility::Expired,
								});

								continue;
							}
						}
					}

					let remaining_millislots = (remaining_slots * 1000) / total_slots;

					let old_alloc_key = keys::ns::RunnerAllocIdxKey::new(
						namespace_id,
						name.clone(),
						version,
						remaining_millislots,
						old_last_ping_ts,
						runner.runner_id,
					);
					let old_lane_alloc_key = keys::ns::RunnerLaneAllocIdxKey::new(
						namespace_id,
						name.clone(),
						worker_lane.as_str().to_owned(),
						version,
						remaining_millislots,
						old_last_ping_ts,
						runner.runner_id,
					);
					let alloc_data = rivet_data::converted::RunnerAllocIdxKeyData {
						workflow_id,
						remaining_slots,
						total_slots,
						protocol_version,
					};

					match runner.action {
						Action::ClearIdx => {
							clear_legacy_alloc_indexes(&tx, namespace_id, &name, runner.runner_id)
								.await?;
							clear_alloc_buckets(
								&tx,
								namespace_id,
								&name,
								&worker_lane,
								runner.runner_id,
							)
							.await?;
						}
						Action::AddIdx => {
							clear_legacy_alloc_indexes(&tx, namespace_id, &name, runner.runner_id)
								.await?;
							clear_alloc_buckets(
								&tx,
								namespace_id,
								&name,
								&worker_lane,
								runner.runner_id,
							)
							.await?;
							if worker_lane == WorkerLane::default() {
								tx.write(&old_alloc_key, alloc_data)?;
							} else {
								tx.write(&old_lane_alloc_key, alloc_data)?;
							}
							write_distributed_alloc_buckets(
								&tx,
								namespace_id,
								&name,
								&worker_lane,
								version,
								old_last_ping_ts,
								runner.runner_id,
								workflow_id,
								remaining_slots,
								total_slots,
								protocol_version,
							)?;
						}
						Action::UpdatePing { rtt } => {
							let last_ping_ts = util::timestamp::now();

							// Write new ping
							tx.write(&last_ping_ts_key, last_ping_ts)?;

							let last_rtt_key = keys::runner::LastRttKey::new(runner.runner_id);
							tx.write(&last_rtt_key, rtt)?;

							// Keep runner liveness separate from capacity indexes. Allocators refresh
							// stale index timestamps from LastPingTsKey on demand, which keeps
							// heartbeat writes from conflicting with every actor allocation bucket.
							if !draining {
								if last_ping_ts.saturating_sub(old_last_ping_ts)
									> runner_eligible_threshold
								{
									notifications.push(RunnerNotification {
										runner_id: runner.runner_id,
										workflow_id,
										eligibility: RunnerEligibility::ReEligible,
									});
								}
							}
						}
					}
				}

				Ok(notifications)
			}
		})
		.custom_instrument(tracing::info_span!("runner_update_alloc_idx_tx"))
		.await?;

	Ok(Output { notifications })
}

pub(crate) async fn clear_legacy_alloc_indexes(
	tx: &universaldb::Transaction,
	namespace_id: Id,
	name: &str,
	runner_id: Id,
) -> Result<()> {
	let runner_alloc_subspace = keys::subspace().subspace(&keys::ns::RunnerAllocIdxKey::subspace(
		namespace_id,
		name.to_owned(),
	));
	let mut stream = tx.get_ranges_keyvalues(
		universaldb::RangeOption {
			mode: StreamingMode::Iterator,
			..(&runner_alloc_subspace).into()
		},
		Snapshot,
	);
	while let Some(entry) = stream.try_next().await? {
		let (key, _) = tx.read_entry::<keys::ns::RunnerAllocIdxKey>(&entry)?;
		if key.runner_id == runner_id {
			tx.add_conflict_key(&key, ConflictRangeType::Read)?;
			tx.delete(&key);
		}
	}

	let runner_lane_alloc_subspace = keys::subspace().subspace(
		&keys::ns::RunnerLaneAllocIdxKey::name_subspace(namespace_id, name.to_owned()),
	);
	let mut stream = tx.get_ranges_keyvalues(
		universaldb::RangeOption {
			mode: StreamingMode::Iterator,
			..(&runner_lane_alloc_subspace).into()
		},
		Snapshot,
	);
	while let Some(entry) = stream.try_next().await? {
		let (key, _) = tx.read_entry::<keys::ns::RunnerLaneAllocIdxKey>(&entry)?;
		if key.runner_id == runner_id {
			tx.add_conflict_key(&key, ConflictRangeType::Read)?;
			tx.delete(&key);
		}
	}

	Ok(())
}

pub(crate) async fn clear_alloc_buckets(
	tx: &universaldb::Transaction,
	namespace_id: Id,
	name: &str,
	worker_lane: &WorkerLane,
	runner_id: Id,
) -> Result<()> {
	for bucket in 0..ALLOC_INDEX_BUCKET_COUNT {
		if worker_lane == &WorkerLane::default() {
			let runner_alloc_subspace = keys::subspace().subspace(
				&keys::ns::RunnerAllocBucketIdxKey::subspace(namespace_id, name.to_owned(), bucket),
			);
			let mut stream = tx.get_ranges_keyvalues(
				universaldb::RangeOption {
					mode: StreamingMode::Iterator,
					..(&runner_alloc_subspace).into()
				},
				Snapshot,
			);

			while let Some(entry) = stream.try_next().await? {
				let (key, _) = tx.read_entry::<keys::ns::RunnerAllocBucketIdxKey>(&entry)?;
				if key.runner_id == runner_id {
					tx.add_conflict_key(&key, ConflictRangeType::Read)?;
					tx.delete(&key);
				}
			}
		} else {
			let runner_alloc_subspace =
				keys::subspace().subspace(&keys::ns::RunnerLaneAllocBucketIdxKey::subspace(
					namespace_id,
					name.to_owned(),
					worker_lane.as_str().to_owned(),
					bucket,
				));
			let mut stream = tx.get_ranges_keyvalues(
				universaldb::RangeOption {
					mode: StreamingMode::Iterator,
					..(&runner_alloc_subspace).into()
				},
				Snapshot,
			);

			while let Some(entry) = stream.try_next().await? {
				let (key, _) = tx.read_entry::<keys::ns::RunnerLaneAllocBucketIdxKey>(&entry)?;
				if key.runner_id == runner_id {
					tx.add_conflict_key(&key, ConflictRangeType::Read)?;
					tx.delete(&key);
				}
			}
		}
	}

	Ok(())
}

pub(crate) fn write_distributed_alloc_buckets(
	tx: &universaldb::Transaction,
	namespace_id: Id,
	name: &str,
	worker_lane: &WorkerLane,
	version: u32,
	last_ping_ts: i64,
	runner_id: Id,
	workflow_id: Id,
	remaining_slots: u32,
	total_slots: u32,
	protocol_version: u16,
) -> Result<()> {
	for bucket in 0..ALLOC_INDEX_BUCKET_COUNT {
		let bucket_total_slots = bucket_slot_capacity(total_slots, bucket);
		if bucket_total_slots == 0 {
			continue;
		}

		let bucket_remaining = bucket_remaining_slots(remaining_slots, bucket);
		let data = rivet_data::converted::RunnerAllocIdxKeyData {
			workflow_id,
			remaining_slots: bucket_remaining,
			total_slots: bucket_total_slots,
			protocol_version,
		};
		write_alloc_bucket(
			tx,
			namespace_id,
			name,
			worker_lane,
			bucket,
			version,
			last_ping_ts,
			runner_id,
			data,
		)?;
	}

	Ok(())
}

fn write_alloc_bucket(
	tx: &universaldb::Transaction,
	namespace_id: Id,
	name: &str,
	worker_lane: &WorkerLane,
	bucket: u16,
	version: u32,
	last_ping_ts: i64,
	runner_id: Id,
	data: rivet_data::converted::RunnerAllocIdxKeyData,
) -> Result<()> {
	if data.total_slots == 0 {
		return Ok(());
	}

	let remaining_millislots = bucket_remaining_millislots(data.remaining_slots, data.total_slots);
	if worker_lane == &WorkerLane::default() {
		tx.write(
			&keys::ns::RunnerAllocBucketIdxKey::new(
				namespace_id,
				name.to_owned(),
				bucket,
				version,
				remaining_millislots,
				last_ping_ts,
				runner_id,
			),
			data,
		)?;
	} else {
		tx.write(
			&keys::ns::RunnerLaneAllocBucketIdxKey::new(
				namespace_id,
				name.to_owned(),
				worker_lane.as_str().to_owned(),
				bucket,
				version,
				remaining_millislots,
				last_ping_ts,
				runner_id,
			),
			data,
		)?;
	}

	Ok(())
}
