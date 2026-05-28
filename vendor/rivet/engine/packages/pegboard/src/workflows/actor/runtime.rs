// runner wf see how signal fail handling
use base64::Engine;
use base64::prelude::BASE64_STANDARD;
use futures_util::StreamExt;
use futures_util::TryStreamExt;
use gas::prelude::*;
use rivet_runner_protocol::{
	self as protocol, PROTOCOL_MK1_VERSION, PROTOCOL_MK2_VERSION, versioned,
};
use rivet_types::actors::CrashPolicy;
use rivet_types::runner_configs::RunnerConfigKind;
use std::{
	sync::{
		Arc,
		atomic::{AtomicU64, AtomicUsize, Ordering},
	},
	time::{Duration, Instant},
};
use universaldb::prelude::*;
use universalpubsub::PublishOpts;
use vbare::OwnedVersionedData;

use super::FailureReason;

use crate::{
	executor::{
		RunnerAllocIndexCandidate, RunnerAllocIndexKey, WorkerLane, WorkerLanePlacement,
		WorkerLanePlacementInput, actor_placement_key, alloc_bucket_for_placement_key,
		place_actor_in_worker_lane,
	},
	keys, metrics,
	routing_directory::{RoutingDelta, RoutingTarget, publish_delta_best_effort},
};

use super::{Allocate, Destroy, Input, PendingAllocation, State, destroy};

const SLOW_ACTOR_ALLOCATION_HOP_MS: u128 = 1000;
const SLOW_ACTOR_COMMAND_HOP_MS: u128 = 1000;
const SLOW_ACTOR_SPAWN_HOP_MS: u128 = 1000;

fn log_slow_actor_allocation_hop(actor_id: Id, allocation_hop: &'static str, duration: Duration) {
	let allocation_hop_duration_ms = duration.as_millis();
	if allocation_hop_duration_ms >= SLOW_ACTOR_ALLOCATION_HOP_MS {
		tracing::warn!(
			?actor_id,
			allocation_hop,
			allocation_hop_duration_ms,
			"slow actor allocation hop"
		);
	}
}

fn log_slow_actor_allocation_tx(
	actor_id: Id,
	allocation_hop: &'static str,
	duration: Duration,
	allocation_attempts: usize,
	allocation_tx_inner_duration_ms: u64,
	allocation_tx_commit_retry_duration_ms: u64,
) {
	let allocation_hop_duration_ms = duration.as_millis();
	if allocation_hop_duration_ms >= SLOW_ACTOR_ALLOCATION_HOP_MS {
		tracing::warn!(
			?actor_id,
			allocation_hop,
			allocation_hop_duration_ms,
			allocation_attempts,
			allocation_tx_inner_duration_ms,
			allocation_tx_commit_retry_duration_ms,
			"slow actor allocation hop"
		);
	}
}

fn log_slow_actor_command_hop(
	actor_id: Id,
	runner_id: Id,
	command_hop: &'static str,
	duration: Duration,
) {
	let command_hop_duration_ms = duration.as_millis();
	if command_hop_duration_ms >= SLOW_ACTOR_COMMAND_HOP_MS {
		tracing::warn!(
			?actor_id,
			?runner_id,
			command_hop,
			command_hop_duration_ms,
			"slow actor command dispatch hop"
		);
	}
}

fn log_slow_actor_command_tx_hop(
	actor_id: Id,
	runner_id: Id,
	command_hop: &'static str,
	duration: Duration,
	command_attempts: usize,
	command_tx_inner_duration_ms: u64,
	command_tx_commit_retry_duration_ms: u64,
) {
	let command_hop_duration_ms = duration.as_millis();
	if command_hop_duration_ms >= SLOW_ACTOR_COMMAND_HOP_MS {
		tracing::warn!(
			?actor_id,
			?runner_id,
			command_hop,
			command_hop_duration_ms,
			command_attempts,
			command_tx_inner_duration_ms,
			command_tx_commit_retry_duration_ms,
			"slow actor command dispatch hop"
		);
	}
}

fn log_slow_actor_spawn_hop(actor_id: Id, spawn_hop: &'static str, duration: Duration) {
	let spawn_hop_duration_ms = duration.as_millis();
	if spawn_hop_duration_ms >= SLOW_ACTOR_SPAWN_HOP_MS {
		tracing::warn!(
			?actor_id,
			spawn_hop,
			spawn_hop_duration_ms,
			"slow actor spawn hop"
		);
	}
}

fn log_slow_actor_spawn_runner_hop(
	actor_id: Id,
	runner_id: Id,
	runner_protocol_version: u16,
	spawn_hop: &'static str,
	duration: Duration,
) {
	let spawn_hop_duration_ms = duration.as_millis();
	if spawn_hop_duration_ms >= SLOW_ACTOR_SPAWN_HOP_MS {
		tracing::warn!(
			?actor_id,
			?runner_id,
			runner_protocol_version,
			spawn_hop,
			spawn_hop_duration_ms,
			"slow actor spawn hop"
		);
	}
}

async fn allocation_candidate_if_live(
	tx: &universaldb::Transaction,
	actor_id: Id,
	ping_threshold_ts: i64,
	candidate: RunnerAllocIndexCandidate,
) -> Result<Option<RunnerAllocIndexCandidate>> {
	if candidate.last_ping_ts() >= ping_threshold_ts {
		return Ok(Some(candidate));
	}

	let hop_started = Instant::now();
	let latest_last_ping_ts = tx
		.read_opt(
			&keys::runner::LastPingTsKey::new(candidate.runner_id()),
			Snapshot,
		)
		.await?;
	log_slow_actor_allocation_hop(
		actor_id,
		"allocate_actor_v2.refresh_last_ping",
		hop_started.elapsed(),
	);

	let Some(latest_last_ping_ts) = latest_last_ping_ts else {
		return Ok(None);
	};
	if latest_last_ping_ts < ping_threshold_ts {
		return Ok(None);
	}

	Ok(Some(candidate.with_last_ping_ts(latest_last_ping_ts)))
}

#[derive(Debug, Deserialize, Serialize)]
pub struct LifecycleRunnerState {
	pub last_event_idx: i64,
	pub last_event_ack_idx: i64,
}

impl Default for LifecycleRunnerState {
	fn default() -> Self {
		LifecycleRunnerState {
			last_event_idx: -1,
			last_event_ack_idx: -1,
		}
	}
}

// TODO: Rewrite this as a series of nested structs/enums for better transparency of current state (likely
// requires actor wf v2)
#[derive(Deserialize, Serialize)]
pub struct LifecycleState {
	pub generation: u32,

	// Set when currently running (not rescheduling or sleeping)
	pub runner_id: Option<Id>,
	pub runner_workflow_id: Option<Id>,
	pub runner_protocol_version: Option<u16>,
	pub runner_state: Option<LifecycleRunnerState>,
	#[serde(default)]
	pub metrics_workflow_id: Option<Id>,
	#[serde(default)]
	pub metrics_resume_ts: Option<i64>,
	#[serde(default)]
	pub metrics_resume_start_ts: Option<i64>,

	pub sleeping: bool,
	#[serde(default)]
	pub stopping: bool,
	#[serde(default)]
	pub going_away: bool,

	/// If a wake was received in between an actor's intent to sleep and actor stop.
	#[serde(default)]
	pub will_wake: bool,
	pub alarm_ts: Option<i64>,
	/// Handles cleaning up the actor if it does not receive a certain state before the timeout (ex.
	/// created -> running event, stop intent -> stop event). If the timeout is reached, the actor is
	/// considered lost.
	pub gc_timeout_ts: Option<i64>,

	pub reschedule_state: RescheduleState,
}

impl LifecycleState {
	pub fn new(
		runner_id: Id,
		runner_workflow_id: Id,
		runner_protocol_version: u16,
		actor_start_threshold: i64,
	) -> Self {
		LifecycleState {
			generation: 0,
			runner_id: Some(runner_id),
			runner_workflow_id: Some(runner_workflow_id),
			runner_protocol_version: Some(runner_protocol_version),
			runner_state: Some(LifecycleRunnerState::default()),
			metrics_workflow_id: None,
			metrics_resume_ts: None,
			metrics_resume_start_ts: None,
			sleeping: false,
			stopping: false,
			going_away: false,
			will_wake: false,
			alarm_ts: None,
			gc_timeout_ts: Some(util::timestamp::now() + actor_start_threshold),
			reschedule_state: RescheduleState::default(),
		}
	}

	pub fn new_sleeping() -> Self {
		LifecycleState {
			generation: 0,
			runner_id: None,
			runner_workflow_id: None,
			runner_protocol_version: None,
			runner_state: None,
			metrics_workflow_id: None,
			metrics_resume_ts: None,
			metrics_resume_start_ts: None,
			sleeping: true,
			stopping: false,
			going_away: false,
			will_wake: false,
			alarm_ts: None,
			gc_timeout_ts: None,
			reschedule_state: RescheduleState::default(),
		}
	}

	pub fn result(&self, migrate_to_v2: bool) -> LifecycleResult {
		LifecycleResult {
			generation: self.generation,
			migrate_to_v2,
			metrics_workflow_id: self.metrics_workflow_id,
		}
	}
}

#[derive(Serialize, Deserialize)]
pub struct LifecycleResult {
	pub generation: u32,
	#[serde(default)]
	pub migrate_to_v2: bool,
	#[serde(default)]
	pub metrics_workflow_id: Option<Id>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct RescheduleState {
	last_retry_ts: i64,
	retry_count: usize,
}

#[derive(Debug, Serialize, Deserialize, Hash)]
struct UpdateRunnerInput {
	actor_id: Id,
	runner_id: Id,
	runner_workflow_id: Id,
}

// This is called when allocated by an outside source while the actor was pending.
#[activity(UpdateRunner)]
async fn update_runner(ctx: &ActivityCtx, input: &UpdateRunnerInput) -> Result<()> {
	let mut state = ctx.state::<State>()?;

	state.sleep_ts = None;
	state.pending_allocation_ts = None;
	state.failure_reason = None;
	state.runner_id = Some(input.runner_id);
	state.runner_workflow_id = Some(input.runner_workflow_id);

	ctx.udb()?
		.run(|tx| async move {
			let tx = tx.with_subspace(keys::subspace());

			// Set actor as not sleeping
			tx.delete(&keys::actor::SleepTsKey::new(input.actor_id));

			Ok(())
		})
		.await?;

	Ok(())
}

#[derive(Debug, Serialize, Deserialize, Hash)]
struct AllocateActorInputV1 {
	actor_id: Id,
	generation: u32,
	force_allocate: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AllocateActorOutputV1 {
	Allocated {
		runner_id: Id,
		runner_workflow_id: Id,
	},
	Pending {
		pending_allocation_ts: i64,
	},
	Sleep,
}

#[activity(AllocateActor)]
async fn allocate_actor(
	ctx: &ActivityCtx,
	input: &AllocateActorInputV1,
) -> Result<AllocateActorOutputV1> {
	bail!("allocate actor v1 should never be called again")
}

#[derive(Debug, Serialize, Deserialize, Hash)]
struct AllocateActorInputV2 {
	actor_id: Id,
	generation: u32,
	force_allocate: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct AllocateActorOutputV2 {
	status: AllocateActorStatus,
	serverless: bool,
}

impl From<AllocateActorOutputV1> for AllocateActorOutputV2 {
	fn from(value: AllocateActorOutputV1) -> Self {
		Self {
			serverless: false,
			status: match value {
				AllocateActorOutputV1::Allocated {
					runner_id,
					runner_workflow_id,
				} => AllocateActorStatus::Allocated {
					runner_id,
					runner_workflow_id,
					runner_protocol_version: None,
				},
				AllocateActorOutputV1::Pending {
					pending_allocation_ts,
				} => AllocateActorStatus::Pending {
					pending_allocation_ts,
				},
				AllocateActorOutputV1::Sleep => AllocateActorStatus::Sleep,
			},
		}
	}
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AllocateActorStatus {
	Allocated {
		runner_id: Id,
		runner_workflow_id: Id,
		#[serde(default)]
		runner_protocol_version: Option<u16>,
	},
	Pending {
		pending_allocation_ts: i64,
	},
	Sleep,
	MigrateToV2,
}

// If no availability, returns the timestamp of the actor's queue key
#[activity(AllocateActorV2)]
async fn allocate_actor_v2(
	ctx: &ActivityCtx,
	input: &AllocateActorInputV2,
) -> Result<AllocateActorOutputV2> {
	let start_instant = Instant::now();

	let hop_started = Instant::now();
	let mut state = ctx.state::<State>()?;
	log_slow_actor_allocation_hop(
		input.actor_id,
		"allocate_actor_v2.state",
		hop_started.elapsed(),
	);

	let namespace_id = state.namespace_id;
	let crash_policy = state.crash_policy;
	let runner_name_selector = &state.runner_name_selector;
	let worker_lane = state.worker_lane();
	let placement_key = actor_placement_key(
		namespace_id,
		&state.name,
		state.key.as_deref(),
		input.actor_id,
	);

	let runner_eligible_threshold = ctx.config().pegboard().runner_eligible_threshold();
	let actor_allocation_candidate_sample_size = ctx
		.config()
		.pegboard()
		.actor_allocation_candidate_sample_size();

	let hop_started = Instant::now();
	let pool_res = ctx
		.op(crate::ops::runner_config::get::Input {
			runners: vec![(namespace_id, runner_name_selector.clone())],
			bypass_cache: false,
		})
		.await?;
	log_slow_actor_allocation_hop(
		input.actor_id,
		"allocate_actor_v2.runner_config",
		hop_started.elapsed(),
	);

	let pool = pool_res.into_iter().next();
	let for_serverless = pool
		.as_ref()
		.map(|pool| matches!(pool.config.kind, RunnerConfigKind::Serverless { .. }))
		.unwrap_or(false);

	// Protocol version is set or this is a serverless pool
	if pool.and_then(|p| p.protocol_version).is_some() {
		return Ok(AllocateActorOutputV2 {
			status: AllocateActorStatus::MigrateToV2,
			serverless: false,
		});
	}

	// NOTE: This txn should closely resemble the one found in the allocate_pending_actors activity of the
	// client wf
	let tx_started = Instant::now();
	let tx_attempts = Arc::new(AtomicUsize::new(0));
	let tx_inner_duration_ms = Arc::new(AtomicU64::new(0));
	let tx_attempts_for_closure = tx_attempts.clone();
	let tx_inner_duration_ms_for_closure = tx_inner_duration_ms.clone();
	let res = ctx
		.udb()?
		.run(|tx| {
			tx_attempts_for_closure.fetch_add(1, Ordering::AcqRel);
			let tx_inner_duration_ms = tx_inner_duration_ms_for_closure.clone();

			let placement_key = placement_key.clone();
			let worker_lane = worker_lane.clone();

			async move {
				let attempt_started = Instant::now();
				let result = async move {
					let ping_threshold_ts = util::timestamp::now() - runner_eligible_threshold;

					let tx = tx.with_subspace(keys::subspace());

					// Check if a queue exists
					let pending_actor_subspace = keys::subspace().subspace(
						&keys::ns::PendingActorByRunnerNameSelectorAndLaneKey::subspace(
							namespace_id,
							runner_name_selector.clone(),
							worker_lane.as_str().to_owned(),
						),
					);

					let hop_started = Instant::now();
					let mut queue_stream = tx.get_ranges_keyvalues(
						universaldb::RangeOption {
							mode: StreamingMode::Exact,
							limit: Some(1),
							..(&pending_actor_subspace).into()
						},
						// NOTE: This is not Serializable because we don't want to conflict with other
						// inserts/clears to this range
						Snapshot,
					);
					let queue_exists = queue_stream.next().await.is_some();
					log_slow_actor_allocation_hop(
						input.actor_id,
						"allocate_actor_v2.queue_check",
						hop_started.elapsed(),
					);

					if for_serverless {
						let hop_started = Instant::now();
						tx.atomic_op(
							&rivet_types::keys::pegboard::ns::ServerlessDesiredSlotsKey::new(
								namespace_id,
								runner_name_selector.clone(),
							),
							&1i64.to_le_bytes(),
							MutationType::Add,
						);
						log_slow_actor_allocation_hop(
							input.actor_id,
							"allocate_actor_v2.serverless_desired_slots",
							hop_started.elapsed(),
						);
					}

					if !queue_exists {
						let mut highest_version = None;
						let mut candidates =
							Vec::with_capacity(actor_allocation_candidate_sample_size);
						let allocation_bucket = alloc_bucket_for_placement_key(&placement_key);

						if worker_lane == WorkerLane::default() {
							let hop_started = Instant::now();
							let runner_alloc_subspace = keys::subspace().subspace(
								&keys::ns::RunnerAllocBucketIdxKey::subspace(
									namespace_id,
									runner_name_selector.clone(),
									allocation_bucket,
								),
							);

							let mut stream = tx.get_ranges_keyvalues(
								universaldb::RangeOption {
									mode: StreamingMode::Iterator,
									..(&runner_alloc_subspace).into()
								},
								// NOTE: This is not Serializable because we don't want to conflict with all of the
								// keys, just the one we choose
								Snapshot,
							);

							loop {
								let Some(entry) = stream.try_next().await? else {
									break;
								};

								let (old_runner_alloc_key, old_runner_alloc_key_data) =
									tx.read_entry::<keys::ns::RunnerAllocBucketIdxKey>(&entry)?;

								if let Some(highest_version) = highest_version {
									if old_runner_alloc_key.version < highest_version {
										break;
									}
								} else {
									highest_version = Some(old_runner_alloc_key.version);
								}

								if old_runner_alloc_key.remaining_millislots == 0 {
									break;
								}

								let candidate = RunnerAllocIndexCandidate::from_bucket_default(
									old_runner_alloc_key,
									old_runner_alloc_key_data,
								);
								if let Some(candidate) = allocation_candidate_if_live(
									&tx,
									input.actor_id,
									ping_threshold_ts,
									candidate,
								)
								.await?
								{
									candidates.push(candidate);
								}

								if candidates.len() >= actor_allocation_candidate_sample_size {
									break;
								}
							}
							log_slow_actor_allocation_hop(
								input.actor_id,
								"allocate_actor_v2.candidate_scan.bucket_default",
								hop_started.elapsed(),
							);
						}

						if worker_lane == WorkerLane::default() && candidates.is_empty() {
							highest_version = None;
							let hop_started = Instant::now();
							let runner_alloc_subspace =
								keys::subspace().subspace(&keys::ns::RunnerAllocIdxKey::subspace(
									namespace_id,
									runner_name_selector.clone(),
								));

							let mut stream = tx.get_ranges_keyvalues(
								universaldb::RangeOption {
									mode: StreamingMode::Iterator,
									..(&runner_alloc_subspace).into()
								},
								// NOTE: This is not Serializable because we don't want to conflict with all of the
								// keys, just the one we choose
								Snapshot,
							);

							// Select valid runner candidates for allocation
							loop {
								let Some(entry) = stream.try_next().await? else {
									break;
								};

								let (old_runner_alloc_key, old_runner_alloc_key_data) =
									tx.read_entry::<keys::ns::RunnerAllocIdxKey>(&entry)?;

								if let Some(highest_version) = highest_version {
									// We have passed all of the runners with the highest version. This is reachable if
									// the ping of the highest version workers makes them ineligible
									if old_runner_alloc_key.version < highest_version {
										break;
									}
								} else {
									highest_version = Some(old_runner_alloc_key.version);
								}

								// An empty runner means we have reached the end of the runners with the highest version
								if old_runner_alloc_key.remaining_millislots == 0 {
									break;
								}

								let candidate = RunnerAllocIndexCandidate::from_default(
									old_runner_alloc_key,
									old_runner_alloc_key_data,
								);
								if let Some(candidate) = allocation_candidate_if_live(
									&tx,
									input.actor_id,
									ping_threshold_ts,
									candidate,
								)
								.await?
								{
									candidates.push(candidate);
								}

								// Max candidate size reached
								if candidates.len() >= actor_allocation_candidate_sample_size {
									break;
								}
							}
							log_slow_actor_allocation_hop(
								input.actor_id,
								"allocate_actor_v2.candidate_scan.default",
								hop_started.elapsed(),
							);
						} else if worker_lane != WorkerLane::default() {
							let hop_started = Instant::now();
							let runner_alloc_subspace = keys::subspace().subspace(
								&keys::ns::RunnerLaneAllocBucketIdxKey::subspace(
									namespace_id,
									runner_name_selector.clone(),
									worker_lane.as_str().to_owned(),
									allocation_bucket,
								),
							);

							let mut stream = tx.get_ranges_keyvalues(
								universaldb::RangeOption {
									mode: StreamingMode::Iterator,
									..(&runner_alloc_subspace).into()
								},
								Snapshot,
							);

							loop {
								let Some(entry) = stream.try_next().await? else {
									break;
								};

								let (old_runner_alloc_key, old_runner_alloc_key_data) =
									tx.read_entry::<keys::ns::RunnerLaneAllocBucketIdxKey>(&entry)?;

								if let Some(highest_version) = highest_version {
									if old_runner_alloc_key.version < highest_version {
										break;
									}
								} else {
									highest_version = Some(old_runner_alloc_key.version);
								}

								if old_runner_alloc_key.remaining_millislots == 0 {
									break;
								}

								let candidate = RunnerAllocIndexCandidate::from_bucket_lane(
									old_runner_alloc_key,
									old_runner_alloc_key_data,
								);
								if let Some(candidate) = allocation_candidate_if_live(
									&tx,
									input.actor_id,
									ping_threshold_ts,
									candidate,
								)
								.await?
								{
									candidates.push(candidate);
								}

								if candidates.len() >= actor_allocation_candidate_sample_size {
									break;
								}
							}
							log_slow_actor_allocation_hop(
								input.actor_id,
								"allocate_actor_v2.candidate_scan.bucket_lane",
								hop_started.elapsed(),
							);

							if candidates.is_empty() {
								highest_version = None;
								let hop_started = Instant::now();
								let runner_alloc_subspace = keys::subspace().subspace(
									&keys::ns::RunnerLaneAllocIdxKey::subspace(
										namespace_id,
										runner_name_selector.clone(),
										worker_lane.as_str().to_owned(),
									),
								);

								let mut stream = tx.get_ranges_keyvalues(
									universaldb::RangeOption {
										mode: StreamingMode::Iterator,
										..(&runner_alloc_subspace).into()
									},
									Snapshot,
								);

								// Select valid runner candidates for allocation
								loop {
									let Some(entry) = stream.try_next().await? else {
										break;
									};

									let (old_runner_alloc_key, old_runner_alloc_key_data) =
										tx.read_entry::<keys::ns::RunnerLaneAllocIdxKey>(&entry)?;

									if let Some(highest_version) = highest_version {
										// We have passed all of the runners with the highest version. This is reachable if
										// the ping of the highest version workers makes them ineligible
										if old_runner_alloc_key.version < highest_version {
											break;
										}
									} else {
										highest_version = Some(old_runner_alloc_key.version);
									}

									// An empty runner means we have reached the end of the runners with the highest version
									if old_runner_alloc_key.remaining_millislots == 0 {
										break;
									}

									let candidate = RunnerAllocIndexCandidate::from_lane(
										old_runner_alloc_key,
										old_runner_alloc_key_data,
									);
									if let Some(candidate) = allocation_candidate_if_live(
										&tx,
										input.actor_id,
										ping_threshold_ts,
										candidate,
									)
									.await?
									{
										candidates.push(candidate);
									}

									// Max candidate size reached
									if candidates.len() >= actor_allocation_candidate_sample_size {
										break;
									}
								}
								log_slow_actor_allocation_hop(
									input.actor_id,
									"allocate_actor_v2.candidate_scan.lane",
									hop_started.elapsed(),
								);
							}
						}

						if !candidates.is_empty() {
							let hop_started = Instant::now();
							let lane_candidates = candidates
								.iter()
								.map(RunnerAllocIndexCandidate::worker_candidate)
								.collect::<Vec<_>>();
							log_slow_actor_allocation_hop(
								input.actor_id,
								"allocate_actor_v2.candidate_materialize",
								hop_started.elapsed(),
							);

							let hop_started = Instant::now();
							let placement = place_actor_in_worker_lane(
								WorkerLanePlacementInput {
									actor_key: &placement_key,
									lane: &worker_lane,
									now_ts: util::timestamp::now(),
									runner_eligible_threshold,
								},
								&lane_candidates,
							);
							log_slow_actor_allocation_hop(
								input.actor_id,
								"allocate_actor_v2.lane_placement",
								hop_started.elapsed(),
							);

							if let WorkerLanePlacement::Selected(assignment) = placement {
								let Some(selected_candidate) = candidates
									.iter()
									.find(|candidate| candidate.matches_assignment(&assignment))
								else {
									bail!("worker lane placement selected unknown runner");
								};

								let hop_started = Instant::now();
								// Add read conflict only for this key
								match &selected_candidate.key {
									RunnerAllocIndexKey::Default(key) => {
										tx.add_conflict_key(key, ConflictRangeType::Read)?;
										tx.delete(key);
									}
									RunnerAllocIndexKey::Lane(key) => {
										tx.add_conflict_key(key, ConflictRangeType::Read)?;
										tx.delete(key);
									}
									RunnerAllocIndexKey::BucketDefault(key) => {
										tx.add_conflict_key(key, ConflictRangeType::Read)?;
										tx.delete(key);
									}
									RunnerAllocIndexKey::BucketLane(key) => {
										tx.add_conflict_key(key, ConflictRangeType::Read)?;
										tx.delete(key);
									}
								}

								let new_remaining_slots = assignment.remaining_slots_after;
								let new_remaining_millislots =
									assignment.remaining_millislots_after;

								// Write new allocation key with 1 less slot
								let new_alloc_data =
									selected_candidate.data_with_remaining(new_remaining_slots);
								match selected_candidate.replacement_key(new_remaining_millislots) {
									RunnerAllocIndexKey::Default(key) => {
										tx.write(&key, new_alloc_data)?;
									}
									RunnerAllocIndexKey::Lane(key) => {
										tx.write(&key, new_alloc_data)?;
									}
									RunnerAllocIndexKey::BucketDefault(key) => {
										tx.write(&key, new_alloc_data)?;
									}
									RunnerAllocIndexKey::BucketLane(key) => {
										tx.write(&key, new_alloc_data)?;
									}
								}

								// Bucketed allocation indexes own setup-path capacity. The legacy
								// runner record remains a compatibility/cache value and is refreshed
								// by runner liveness updates instead of every actor create.
								if !selected_candidate.is_bucketed() {
									tx.write(
										&keys::runner::RemainingSlotsKey::new(assignment.runner_id),
										new_remaining_slots,
									)?;
								}

								// Set runner id of actor
								tx.write(
									&keys::actor::RunnerIdKey::new(input.actor_id),
									assignment.runner_id,
								)?;

								// Insert actor index key
								tx.write(
									&keys::runner::ActorKey::new(
										assignment.runner_id,
										input.actor_id,
									),
									input.generation,
								)?;

								// Set actor as not sleeping
								tx.delete(&keys::actor::SleepTsKey::new(input.actor_id));
								log_slow_actor_allocation_hop(
									input.actor_id,
									"allocate_actor_v2.allocated_writes",
									hop_started.elapsed(),
								);

								return Ok(AllocateActorOutputV2 {
									serverless: for_serverless,
									status: AllocateActorStatus::Allocated {
										runner_id: assignment.runner_id,
										runner_workflow_id: assignment.runner_workflow_id,
										runner_protocol_version: assignment.protocol_version,
									},
								});
							} else {
								tracing::debug!(
									actor_id=?input.actor_id,
									lane=%worker_lane.as_str(),
									"no worker lane placement candidate"
								);
							}
						}
					}

					// At this point in the txn there is no availability

					match (crash_policy, input.force_allocate, for_serverless) {
						(CrashPolicy::Sleep, false, false) => Ok(AllocateActorOutputV2 {
							serverless: false,
							status: AllocateActorStatus::Sleep,
						}),
						// Write the actor to the alloc queue to wait
						_ => {
							let pending_allocation_ts = util::timestamp::now();

							let hop_started = Instant::now();
							// NOTE: This will conflict with serializable reads to the alloc queue, which is the behavior we
							// want. If a runner reads from the queue while this is being inserted, one of the two txns will
							// retry and we ensure the actor does not end up in queue limbo.
							tx.write(
								&keys::ns::PendingActorByRunnerNameSelectorAndLaneKey::new(
									namespace_id,
									runner_name_selector.clone(),
									worker_lane.as_str().to_owned(),
									pending_allocation_ts,
									input.actor_id,
								),
								input.generation,
							)?;
							tx.write(
								&keys::ns::PendingActorByRunnerNameSelectorKey::new(
									namespace_id,
									runner_name_selector.clone(),
									pending_allocation_ts,
									input.actor_id,
								),
								input.generation,
							)?;
							log_slow_actor_allocation_hop(
								input.actor_id,
								"allocate_actor_v2.pending_queue_write",
								hop_started.elapsed(),
							);

							Ok(AllocateActorOutputV2 {
								serverless: for_serverless,
								status: AllocateActorStatus::Pending {
									pending_allocation_ts,
								},
							})
						}
					}
				}
				.await;
				tx_inner_duration_ms.fetch_add(
					attempt_started.elapsed().as_millis() as u64,
					Ordering::AcqRel,
				);
				result
			}
		})
		.custom_instrument(tracing::info_span!("actor_allocate_tx"))
		.await?;
	let tx_duration = tx_started.elapsed();
	let allocation_attempts = tx_attempts.load(Ordering::Acquire);
	let tx_inner_duration_ms = tx_inner_duration_ms.load(Ordering::Acquire);
	let tx_commit_retry_duration_ms =
		(tx_duration.as_millis() as u64).saturating_sub(tx_inner_duration_ms);
	log_slow_actor_allocation_tx(
		input.actor_id,
		"allocate_actor_v2.tx_total",
		tx_duration,
		allocation_attempts,
		tx_inner_duration_ms,
		tx_commit_retry_duration_ms,
	);

	let dt = start_instant.elapsed().as_secs_f64();
	let status_label = match &res.status {
		AllocateActorStatus::Allocated { .. } => "allocated",
		AllocateActorStatus::Pending { .. } => "pending",
		AllocateActorStatus::Sleep { .. } => "sleep",
		AllocateActorStatus::MigrateToV2 => bail!("should not be migrate_to_v2"),
	};
	if dt >= 1.0 {
		tracing::warn!(
			actor_id = ?input.actor_id,
			status = status_label,
			serverless = res.serverless,
			allocate_duration_ms = (dt * 1000.0).round() as u64,
			allocation_attempts,
			"slow actor allocation"
		);
	}
	metrics::ACTOR_ALLOCATE_DURATION
		.with_label_values(&[
			if res.serverless {
				"serverless"
			} else {
				"serverful"
			},
			status_label,
		])
		.observe(dt);

	state.for_serverless = res.serverless;
	state.allocated_serverless_slot = res.serverless;
	state.reschedule_ts = None;

	match &res.status {
		AllocateActorStatus::Allocated {
			runner_id,
			runner_workflow_id,
			..
		} => {
			state.sleep_ts = None;
			state.pending_allocation_ts = None;
			state.failure_reason = None;
			state.runner_id = Some(*runner_id);
			state.runner_workflow_id = Some(*runner_workflow_id);
		}
		AllocateActorStatus::Pending {
			pending_allocation_ts,
			..
		} => {
			tracing::debug!(
				actor_id=?input.actor_id,
				"failed to allocate (no availability), waiting for allocation",
			);

			state.pending_allocation_ts = Some(*pending_allocation_ts);
			if state.failure_reason.is_none() {
				state.failure_reason = Some(super::FailureReason::NoCapacity);
			}
		}
		AllocateActorStatus::Sleep => {
			if state.failure_reason.is_none() {
				state.failure_reason = Some(super::FailureReason::NoCapacity);
			}
		}
		AllocateActorStatus::MigrateToV2 => bail!("should not be migrate_to_v2"),
	}

	Ok(res)
}

#[derive(Debug, Serialize, Deserialize, Hash)]
pub struct SetNotConnectableInput {
	pub actor_id: Id,
}

#[activity(SetNotConnectable)]
pub async fn set_not_connectable(ctx: &ActivityCtx, input: &SetNotConnectableInput) -> Result<()> {
	let mut state = ctx.state::<State>()?;

	ctx.udb()?
		.run(|tx| async move {
			let tx = tx.with_subspace(keys::subspace());

			let connectable_key = keys::actor::ConnectableKey::new(input.actor_id);
			tx.clear(&keys::subspace().pack(&connectable_key));

			Ok(())
		})
		.custom_instrument(tracing::info_span!("actor_set_not_connectable_tx"))
		.await?;

	state.connectable_ts = None;

	Ok(())
}

#[derive(Debug, Serialize, Deserialize, Hash)]
pub struct DeallocateInput {
	pub actor_id: Id,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct DeallocateOutput {
	pub for_serverless: bool,
}

#[activity(Deallocate)]
pub async fn deallocate(ctx: &ActivityCtx, input: &DeallocateInput) -> Result<DeallocateOutput> {
	let mut state = ctx.state::<State>()?;
	let namespace_id = state.namespace_id;
	let name = &state.name;
	let key = &state.key;
	let runner_name_selector = &state.runner_name_selector;
	let runner_id = state.runner_id;
	let allocated_serverless_slot = state.allocated_serverless_slot;

	ctx.udb()?
		.run(|tx| async move {
			let tx = tx.with_subspace(keys::subspace());

			tx.delete(&keys::actor::ConnectableKey::new(input.actor_id));

			destroy::clear_slot(
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

			Ok(())
		})
		.custom_instrument(tracing::info_span!("actor_deallocate_tx"))
		.await?;

	state.connectable_ts = None;
	state.runner_id = None;
	state.runner_workflow_id = None;
	state.runner_state = None;
	// Slot was cleared by the above txn
	state.allocated_serverless_slot = false;

	Ok(DeallocateOutput {
		for_serverless: state.for_serverless,
	})
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum AllocationOverride {
	#[default]
	None,
	/// Forces actors with CrashPolicy::Sleep to pend instead of sleep.
	DontSleep { pending_timeout: Option<i64> },
	/// If an allocation results in pending, it will be put to sleep if it is not allocated after this
	/// timeout.
	PendingTimeout { pending_timeout: i64 },
}

#[derive(Debug)]
pub enum SpawnActorOutput {
	Allocated {
		runner_id: Id,
		runner_workflow_id: Id,
		runner_protocol_version: u16,
	},
	Sleep,
	Destroy,
	MigrateToV2,
}

/// Wrapper around `allocate_actor` that handles pending state.
pub async fn spawn_actor(
	ctx: &mut WorkflowCtx,
	input: &Input,
	generation: u32,
	allocation_override: AllocationOverride,
) -> Result<SpawnActorOutput> {
	// Attempt allocation
	let hop_started = Instant::now();
	let workflow_version = ctx.check_version(2).await?;
	log_slow_actor_spawn_hop(input.actor_id, "check_version", hop_started.elapsed());

	let hop_started = Instant::now();
	let (allocate_res, allocate_hop): (AllocateActorOutputV2, &'static str) = match workflow_version
	{
		1 => (
			ctx.activity(AllocateActorInputV1 {
				actor_id: input.actor_id,
				generation,
				force_allocate: matches!(
					&allocation_override,
					AllocationOverride::DontSleep { .. }
				),
			})
			.await?
			.into(),
			"allocate_actor_v1",
		),
		_latest => (
			ctx.v(2)
				.activity(AllocateActorInputV2 {
					actor_id: input.actor_id,
					generation,
					force_allocate: matches!(
						&allocation_override,
						AllocationOverride::DontSleep { .. }
					),
				})
				.await?,
			"allocate_actor_v2",
		),
	};
	log_slow_actor_spawn_hop(input.actor_id, allocate_hop, hop_started.elapsed());

	match allocate_res.status {
		AllocateActorStatus::Allocated {
			runner_id,
			runner_workflow_id,
			runner_protocol_version,
		} => {
			let runner_protocol_version = runner_protocol_version.unwrap_or(PROTOCOL_MK1_VERSION);

			let hop_started = Instant::now();
			if ctx.has_current_history_event() {
				ctx.removed::<Message<super::BumpServerlessAutoscalerStub>>()
					.await?;
			}
			log_slow_actor_spawn_hop(
				input.actor_id,
				"allocated.removed_bump_stub",
				hop_started.elapsed(),
			);

			// Bump the pool so it can scale up
			if allocate_res.serverless {
				let hop_started = Instant::now();
				let res = ctx
					.v(2)
					.signal(crate::workflows::runner_pool::Bump::default())
					.to_workflow::<crate::workflows::runner_pool::Workflow>()
					.tag("namespace_id", input.namespace_id)
					.tag("runner_name", input.runner_name_selector.clone())
					.send()
					.await;

				if let Some(WorkflowError::WorkflowNotFound) = res
					.as_ref()
					.err()
					.and_then(|x| x.chain().find_map(|x| x.downcast_ref::<WorkflowError>()))
				{
					tracing::warn!(
						namespace_id=%input.namespace_id,
						runner_name=%input.runner_name_selector,
						"serverless pool workflow not found, respective runner config likely deleted"
					);
				} else {
					res?;
				}
				log_slow_actor_spawn_hop(
					input.actor_id,
					"allocated.serverless_bump",
					hop_started.elapsed(),
				);
			}

			let command_dispatch_started = Instant::now();
			if protocol::is_mk2(runner_protocol_version) {
				ctx.activity(InsertAndSendCommandsInput {
					actor_id: input.actor_id,
					generation,
					runner_id,
					commands: vec![protocol::mk2::Command::CommandStartActor(
						protocol::mk2::CommandStartActor {
							config: protocol::mk2::ActorConfig {
								name: input.name.clone(),
								key: input.key.clone(),
								// HACK: We should not use dynamic timestamp here, but we don't validate if signal data
								// changes (like activity inputs) so this is fine for now.
								create_ts: util::timestamp::now(),
								input: input
									.input
									.as_ref()
									.and_then(|x| BASE64_STANDARD.decode(x).ok()),
							},
							// Empty because request ids are ephemeral. This is intercepted by guard and
							// populated before it reaches the runner
							hibernating_requests: Vec::new(),
						},
					)],
				})
				.await?;
			} else {
				ctx.signal(crate::workflows::runner::Command {
					inner: protocol::Command::CommandStartActor(protocol::CommandStartActor {
						actor_id: input.actor_id.to_string(),
						generation,
						config: protocol::ActorConfig {
							name: input.name.clone(),
							key: input.key.clone(),
							// HACK: We should not use dynamic timestamp here, but we don't validate if signal data
							// changes (like activity inputs) so this is fine for now.
							create_ts: util::timestamp::now(),
							input: input
								.input
								.as_ref()
								.map(|x| BASE64_STANDARD.decode(x))
								.transpose()?,
						},
						// Empty because request ids are ephemeral. This is intercepted by guard and
						// populated before it reaches the runner
						hibernating_requests: Vec::new(),
					}),
				})
				.to_workflow_id(runner_workflow_id)
				.send()
				.await?;
			}
			let command_dispatch_duration = command_dispatch_started.elapsed();
			log_slow_actor_spawn_runner_hop(
				input.actor_id,
				runner_id,
				runner_protocol_version,
				"allocated.command_dispatch",
				command_dispatch_duration,
			);
			let command_dispatch_duration_ms = command_dispatch_duration.as_millis();
			if command_dispatch_duration_ms >= 1000 {
				tracing::warn!(
					actor_id = ?input.actor_id,
					runner_id = ?runner_id,
					runner_protocol_version,
					command_dispatch_duration_ms,
					"slow actor command dispatch"
				);
			}

			Ok(SpawnActorOutput::Allocated {
				runner_id,
				runner_workflow_id,
				runner_protocol_version,
			})
		}
		AllocateActorStatus::Pending {
			pending_allocation_ts,
		} => {
			let hop_started = Instant::now();
			if ctx.has_current_history_event() {
				ctx.removed::<Message<super::BumpServerlessAutoscalerStub>>()
					.await?;
			}
			log_slow_actor_spawn_hop(
				input.actor_id,
				"pending.removed_bump_stub",
				hop_started.elapsed(),
			);

			// Bump the pool so it can scale up
			if allocate_res.serverless {
				let hop_started = Instant::now();
				let res = ctx
					.v(2)
					.signal(crate::workflows::runner_pool::Bump::default())
					.to_workflow::<crate::workflows::runner_pool::Workflow>()
					.tag("namespace_id", input.namespace_id)
					.tag("runner_name", input.runner_name_selector.clone())
					.send()
					.await;

				if let Some(WorkflowError::WorkflowNotFound) = res
					.as_ref()
					.err()
					.and_then(|x| x.chain().find_map(|x| x.downcast_ref::<WorkflowError>()))
				{
					tracing::warn!(
						namespace_id=%input.namespace_id,
						runner_name=%input.runner_name_selector,
						"serverless pool workflow not found, respective runner config likely deleted"
					);
				} else {
					res?;
				}
				log_slow_actor_spawn_hop(
					input.actor_id,
					"pending.serverless_bump",
					hop_started.elapsed(),
				);
			}

			let hop_started = Instant::now();
			let signal = match allocation_override {
				AllocationOverride::DontSleep {
					pending_timeout: Some(timeout),
				}
				| AllocationOverride::PendingTimeout {
					pending_timeout: timeout,
				} => {
					ctx.listen_with_timeout::<PendingAllocation>(timeout)
						.await?
				}
				_ => Some(ctx.listen::<PendingAllocation>().await?),
			};
			log_slow_actor_spawn_hop(
				input.actor_id,
				"pending.listen_allocation",
				hop_started.elapsed(),
			);

			// If allocation fails, the allocate txn already inserted this actor into the queue. Now we wait for
			// an `Allocate` signal
			match signal {
				Some(PendingAllocation::Allocate(sig)) => {
					let runner_protocol_version =
						sig.runner_protocol_version.unwrap_or(PROTOCOL_MK1_VERSION);

					let hop_started = Instant::now();
					ctx.activity(UpdateRunnerInput {
						actor_id: input.actor_id,
						runner_id: sig.runner_id,
						runner_workflow_id: sig.runner_workflow_id,
					})
					.await?;
					log_slow_actor_spawn_runner_hop(
						input.actor_id,
						sig.runner_id,
						runner_protocol_version,
						"pending.update_runner",
						hop_started.elapsed(),
					);

					let command_dispatch_started = Instant::now();
					if protocol::is_mk2(runner_protocol_version) {
						ctx.activity(InsertAndSendCommandsInput {
							actor_id: input.actor_id,
							generation,
							runner_id: sig.runner_id,
							commands: vec![protocol::mk2::Command::CommandStartActor(
								protocol::mk2::CommandStartActor {
									config: protocol::mk2::ActorConfig {
										name: input.name.clone(),
										key: input.key.clone(),
										create_ts: util::timestamp::now(),
										input: input
											.input
											.as_ref()
											.map(|x| BASE64_STANDARD.decode(x))
											.transpose()?,
									},
									// Empty because request ids are ephemeral. This is intercepted by guard and
									// populated before it reaches the runner
									hibernating_requests: Vec::new(),
								},
							)],
						})
						.await?;
					} else {
						ctx.signal(crate::workflows::runner::Command {
							inner: protocol::Command::CommandStartActor(
								protocol::CommandStartActor {
									actor_id: input.actor_id.to_string(),
									generation,
									config: protocol::ActorConfig {
										name: input.name.clone(),
										key: input.key.clone(),
										create_ts: util::timestamp::now(),
										input: input
											.input
											.as_ref()
											.map(|x| BASE64_STANDARD.decode(x))
											.transpose()?,
									},
									// Empty because request ids are ephemeral. This is intercepted by guard and
									// populated before it reaches the runner
									hibernating_requests: Vec::new(),
								},
							),
						})
						.to_workflow_id(sig.runner_workflow_id)
						.send()
						.await?;
					}
					log_slow_actor_spawn_runner_hop(
						input.actor_id,
						sig.runner_id,
						runner_protocol_version,
						"pending.command_dispatch",
						command_dispatch_started.elapsed(),
					);

					Ok(SpawnActorOutput::Allocated {
						runner_id: sig.runner_id,
						runner_workflow_id: sig.runner_workflow_id,
						runner_protocol_version,
					})
				}
				Some(PendingAllocation::Destroy(_)) => {
					tracing::debug!(actor_id=?input.actor_id, "destroying before actor allocated");

					let hop_started = Instant::now();
					let cleared = ctx
						.activity(ClearPendingAllocationInput {
							actor_id: input.actor_id,
							namespace_id: input.namespace_id,
							runner_name_selector: input.runner_name_selector.clone(),
							pending_allocation_ts,
						})
						.await?;
					log_slow_actor_spawn_hop(
						input.actor_id,
						"pending_destroy.clear_pending_allocation",
						hop_started.elapsed(),
					);

					// If this actor was no longer present in the queue it means it was allocated. We must now
					// wait for the allocated signal to prevent a race condition.
					if !cleared {
						let hop_started = Instant::now();
						let sig = ctx.listen::<Allocate>().await?;
						log_slow_actor_spawn_runner_hop(
							input.actor_id,
							sig.runner_id,
							sig.runner_protocol_version.unwrap_or(PROTOCOL_MK1_VERSION),
							"pending_destroy.listen_late_allocate",
							hop_started.elapsed(),
						);

						let hop_started = Instant::now();
						ctx.activity(UpdateRunnerInput {
							actor_id: input.actor_id,
							runner_id: sig.runner_id,
							runner_workflow_id: sig.runner_workflow_id,
						})
						.await?;
						log_slow_actor_spawn_runner_hop(
							input.actor_id,
							sig.runner_id,
							sig.runner_protocol_version.unwrap_or(PROTOCOL_MK1_VERSION),
							"pending_destroy.update_late_runner",
							hop_started.elapsed(),
						);
					}
					// Bump the pool so it can scale down
					else if allocate_res.serverless {
						let hop_started = Instant::now();
						let res = ctx
							.v(2)
							.signal(crate::workflows::runner_pool::Bump::default())
							.to_workflow::<crate::workflows::runner_pool::Workflow>()
							.tag("namespace_id", input.namespace_id)
							.tag("runner_name", input.runner_name_selector.clone())
							.send()
							.await;

						if let Some(WorkflowError::WorkflowNotFound) = res
							.as_ref()
							.err()
							.and_then(|x| x.chain().find_map(|x| x.downcast_ref::<WorkflowError>()))
						{
							tracing::warn!(
								namespace_id=%input.namespace_id,
								runner_name=%input.runner_name_selector,
								"serverless pool workflow not found, respective runner config likely deleted"
							);
						} else {
							res?;
						}
						log_slow_actor_spawn_hop(
							input.actor_id,
							"pending_destroy.serverless_bump",
							hop_started.elapsed(),
						);
					}

					Ok(SpawnActorOutput::Destroy)
				}
				None => {
					tracing::debug!(actor_id=?input.actor_id, "timed out before actor allocated");

					let hop_started = Instant::now();
					let cleared = ctx
						.activity(ClearPendingAllocationInput {
							actor_id: input.actor_id,
							namespace_id: input.namespace_id,
							runner_name_selector: input.runner_name_selector.clone(),
							pending_allocation_ts,
						})
						.await?;
					log_slow_actor_spawn_hop(
						input.actor_id,
						"pending_timeout.clear_pending_allocation",
						hop_started.elapsed(),
					);

					// If this actor was no longer present in the queue it means it was allocated. We must now
					// wait for the allocated signal to prevent a race condition.
					if !cleared {
						let hop_started = Instant::now();
						let sig = ctx.listen::<Allocate>().await?;
						let runner_protocol_version =
							sig.runner_protocol_version.unwrap_or(PROTOCOL_MK1_VERSION);
						log_slow_actor_spawn_runner_hop(
							input.actor_id,
							sig.runner_id,
							runner_protocol_version,
							"pending_timeout.listen_late_allocate",
							hop_started.elapsed(),
						);

						let hop_started = Instant::now();
						ctx.activity(UpdateRunnerInput {
							actor_id: input.actor_id,
							runner_id: sig.runner_id,
							runner_workflow_id: sig.runner_workflow_id,
						})
						.await?;
						log_slow_actor_spawn_runner_hop(
							input.actor_id,
							sig.runner_id,
							runner_protocol_version,
							"pending_timeout.update_late_runner",
							hop_started.elapsed(),
						);

						let command_dispatch_started = Instant::now();
						if protocol::is_mk2(runner_protocol_version) {
							ctx.activity(InsertAndSendCommandsInput {
								actor_id: input.actor_id,
								generation,
								runner_id: sig.runner_id,
								commands: vec![protocol::mk2::Command::CommandStartActor(
									protocol::mk2::CommandStartActor {
										config: protocol::mk2::ActorConfig {
											name: input.name.clone(),
											key: input.key.clone(),
											create_ts: util::timestamp::now(),
											input: input
												.input
												.as_ref()
												.map(|x| BASE64_STANDARD.decode(x))
												.transpose()?,
										},
										// Empty because request ids are ephemeral. This is intercepted by guard and
										// populated before it reaches the runner
										hibernating_requests: Vec::new(),
									},
								)],
							})
							.await?;
						} else {
							ctx.signal(crate::workflows::runner::Command {
								inner: protocol::Command::CommandStartActor(
									protocol::CommandStartActor {
										actor_id: input.actor_id.to_string(),
										generation,
										config: protocol::ActorConfig {
											name: input.name.clone(),
											key: input.key.clone(),
											create_ts: util::timestamp::now(),
											input: input
												.input
												.as_ref()
												.map(|x| BASE64_STANDARD.decode(x))
												.transpose()?,
										},
										// Empty because request ids are ephemeral. This is intercepted by guard and
										// populated before it reaches the runner
										hibernating_requests: Vec::new(),
									},
								),
							})
							.to_workflow_id(sig.runner_workflow_id)
							.send()
							.await?;
						}
						log_slow_actor_spawn_runner_hop(
							input.actor_id,
							sig.runner_id,
							runner_protocol_version,
							"pending_timeout.command_dispatch",
							command_dispatch_started.elapsed(),
						);

						Ok(SpawnActorOutput::Allocated {
							runner_id: sig.runner_id,
							runner_workflow_id: sig.runner_workflow_id,
							runner_protocol_version,
						})
					} else {
						// Bump the pool so it can scale down
						if allocate_res.serverless {
							let hop_started = Instant::now();
							let res = ctx
								.v(2)
								.signal(crate::workflows::runner_pool::Bump::default())
								.to_workflow::<crate::workflows::runner_pool::Workflow>()
								.tag("namespace_id", input.namespace_id)
								.tag("runner_name", input.runner_name_selector.clone())
								.send()
								.await;

							if let Some(WorkflowError::WorkflowNotFound) =
								res.as_ref().err().and_then(|x| {
									x.chain().find_map(|x| x.downcast_ref::<WorkflowError>())
								}) {
								tracing::warn!(
									namespace_id=%input.namespace_id,
									runner_name=%input.runner_name_selector,
									"serverless pool workflow not found, respective runner config likely deleted"
								);
							} else {
								res?;
							}
							log_slow_actor_spawn_hop(
								input.actor_id,
								"pending_timeout.serverless_bump",
								hop_started.elapsed(),
							);
						}

						Ok(SpawnActorOutput::Sleep)
					}
				}
			}
		}
		AllocateActorStatus::Sleep => Ok(SpawnActorOutput::Sleep),
		AllocateActorStatus::MigrateToV2 => Ok(SpawnActorOutput::MigrateToV2),
	}
}

/// Wrapper around `spawn_actor` that handles rescheduling retries. Returns true if the actor should be
/// destroyed.
pub async fn reschedule_actor(
	ctx: &mut WorkflowCtx,
	input: &Input,
	state: &mut LifecycleState,
	allocation_override: AllocationOverride,
) -> Result<SpawnActorOutput> {
	tracing::debug!(actor_id=?input.actor_id, "rescheduling actor");

	// Determine next backoff sleep duration
	let mut backoff = reschedule_backoff(
		state.reschedule_state.retry_count,
		ctx.config().pegboard().base_retry_timeout(),
		ctx.config().pegboard().reschedule_backoff_max_exponent(),
	);

	let (now, reset) = ctx
		.v(2)
		.activity(CompareRetryInput {
			retry_count: state.reschedule_state.retry_count,
			last_retry_ts: state.reschedule_state.last_retry_ts,
		})
		.await?;

	state.reschedule_state.retry_count = if reset {
		0
	} else {
		state.reschedule_state.retry_count + 1
	};
	state.reschedule_state.last_retry_ts = now;

	// Don't sleep for first retry
	if state.reschedule_state.retry_count > 0 {
		let next = backoff.step().expect("should not have max retry");

		// Sleep for backoff or destroy early
		if let Some(_sig) = ctx
			.listen_with_timeout::<Destroy>(Instant::from(next) - Instant::now())
			.await?
		{
			tracing::debug!("destroying before actor start");

			return Ok(SpawnActorOutput::Destroy);
		}
	}

	let next_generation = state.generation + 1;
	let spawn_res = spawn_actor(ctx, &input, next_generation, allocation_override).await?;

	if let SpawnActorOutput::Allocated {
		runner_id,
		runner_workflow_id,
		runner_protocol_version,
	} = &spawn_res
	{
		state.generation = next_generation;
		state.runner_id = Some(*runner_id);
		state.runner_workflow_id = Some(*runner_workflow_id);
		state.runner_protocol_version = Some(*runner_protocol_version);

		// Reset gc timeout once allocated
		state.gc_timeout_ts =
			Some(util::timestamp::now() + ctx.config().pegboard().actor_start_threshold());

		// Metrics are resumed when the runner reports the actor as running. Keeping this out of
		// the start-command path prevents metrics dispatch from delaying initial readiness.
	}

	Ok(spawn_res)
}

#[derive(Debug, Serialize, Deserialize, Hash)]
pub struct ClearPendingAllocationInput {
	actor_id: Id,
	namespace_id: Id,
	runner_name_selector: String,
	pending_allocation_ts: i64,
}

#[activity(ClearPendingAllocation)]
pub async fn clear_pending_allocation(
	ctx: &ActivityCtx,
	input: &ClearPendingAllocationInput,
) -> Result<bool> {
	let mut state = ctx.state::<State>()?;
	let worker_lane = state.worker_lane();

	let allocated_serverless_slot = state.allocated_serverless_slot;

	// Clear self from alloc queue
	let cleared = ctx
		.udb()?
		.run(|tx| {
			let worker_lane = worker_lane.clone();
			async move {
				let tx = tx.with_subspace(keys::subspace());

				let pending_alloc_key = keys::ns::PendingActorByRunnerNameSelectorKey::new(
					input.namespace_id,
					input.runner_name_selector.clone(),
					input.pending_allocation_ts,
					input.actor_id,
				);
				let pending_alloc_lane_key =
					keys::ns::PendingActorByRunnerNameSelectorAndLaneKey::new(
						input.namespace_id,
						input.runner_name_selector.clone(),
						worker_lane.as_str().to_owned(),
						input.pending_allocation_ts,
						input.actor_id,
					);
				let lane_exists = tx.exists(&pending_alloc_lane_key, Serializable).await?;
				let exists = tx.exists(&pending_alloc_key, Serializable).await? || lane_exists;

				if exists {
					tx.delete(&pending_alloc_lane_key);
					tx.delete(&pending_alloc_key);

					// If the pending actor key still exists, we must clear its desired slot because after this
					// activity the actor will go to sleep or be destroyed. We don't clear the slot if the key
					// doesn't exist because the actor may either be allocated or destroyed.
					if allocated_serverless_slot {
						tx.atomic_op(
							&rivet_types::keys::pegboard::ns::ServerlessDesiredSlotsKey::new(
								input.namespace_id,
								input.runner_name_selector.clone(),
							),
							&(-1i64).to_le_bytes(),
							MutationType::Add,
						);
					}
				}

				Ok(exists)
			}
		})
		.custom_instrument(tracing::info_span!("actor_clear_pending_alloc_tx"))
		.await?;

	// Only mark allocated_serverless_slot as false if it was allocated before and cleared now
	if allocated_serverless_slot && cleared {
		state.allocated_serverless_slot = false;
	}

	Ok(cleared)
}

#[derive(Debug, Serialize, Deserialize, Hash)]
struct CompareRetryInput {
	#[serde(default)]
	retry_count: usize,
	last_retry_ts: i64,
}

#[activity(CompareRetry)]
async fn compare_retry(ctx: &ActivityCtx, input: &CompareRetryInput) -> Result<(i64, bool)> {
	let mut state = ctx.state::<State>()?;

	let now = util::timestamp::now();

	// If the last retry ts is more than RETRY_RESET_DURATION_MS ago, reset retry count
	let reset = input.last_retry_ts < now - ctx.config().pegboard().retry_reset_duration();

	if reset {
		state.reschedule_ts = None;
	} else {
		let backoff = reschedule_backoff(
			input.retry_count,
			ctx.config().pegboard().base_retry_timeout(),
			ctx.config().pegboard().reschedule_backoff_max_exponent(),
		);
		state.reschedule_ts = Some(now + i64::try_from(backoff.current_duration())?);
	}

	Ok((now, reset))
}

#[derive(Debug, Serialize, Deserialize, Hash)]
pub struct SetStartedInput {
	pub actor_id: Id,
	pub runner_id: Id,
	pub generation: u32,
}

#[activity(SetStarted)]
pub async fn set_started(ctx: &ActivityCtx, input: &SetStartedInput) -> Result<()> {
	let mut state = ctx.state::<State>()?;
	let now = util::timestamp::now();

	if state.start_ts.is_none() {
		state.start_ts = Some(now);
	}
	state.connectable_ts = Some(now);

	ctx.udb()?
		.run(|tx| async move {
			let tx = tx.with_subspace(keys::subspace());

			let connectable_key = keys::actor::ConnectableKey::new(input.actor_id);
			tx.set(
				&keys::subspace().pack(&connectable_key),
				&connectable_key.serialize(())?,
			);

			Ok(())
		})
		.custom_instrument(tracing::info_span!("actor_set_started_tx"))
		.await?;

	let ups = ctx.ups()?;
	publish_delta_best_effort(
		&ups,
		RoutingDelta::Ready {
			actor_id: input.actor_id,
			generation: input.generation as u64,
			target: RoutingTarget::Runner {
				runner_id: input.runner_id,
			},
		},
	)
	.await;

	Ok(())
}

#[derive(Debug, Serialize, Deserialize, Hash)]
pub struct SetSleepingInput {
	pub actor_id: Id,
}

#[activity(SetSleeping)]
pub async fn set_sleeping(ctx: &ActivityCtx, input: &SetSleepingInput) -> Result<()> {
	let mut state = ctx.state::<State>()?;
	let now = util::timestamp::now();

	state.sleep_ts = Some(now);
	state.connectable_ts = None;

	ctx.udb()?
		.run(|tx| async move {
			let tx = tx.with_subspace(keys::subspace());

			// Make not connectable
			tx.delete(&keys::actor::ConnectableKey::new(input.actor_id));
			tx.write(&keys::actor::SleepTsKey::new(input.actor_id), now)?;

			Ok(())
		})
		.custom_instrument(tracing::info_span!("actor_set_sleeping_tx"))
		.await?;

	Ok(())
}

#[derive(Debug, Serialize, Deserialize, Hash)]
pub struct SetCompleteInput {}

#[activity(SetComplete)]
pub async fn set_complete(ctx: &ActivityCtx, input: &SetCompleteInput) -> Result<()> {
	let mut state = ctx.state::<State>()?;

	state.complete_ts = Some(util::timestamp::now());

	Ok(())
}

fn reschedule_backoff(
	retry_count: usize,
	base_retry_timeout: usize,
	max_exponent: usize,
) -> util::backoff::Backoff {
	util::backoff::Backoff::new_at(max_exponent, None, base_retry_timeout, 500, retry_count)
}

#[derive(Debug, Serialize, Deserialize, Hash)]
pub struct InsertAndSendCommandsInput {
	pub actor_id: Id,
	pub generation: u32,
	pub runner_id: Id,
	pub commands: Vec<protocol::mk2::Command>,
}

#[activity(InsertAndSendCommands)]
pub async fn insert_and_send_commands(
	ctx: &ActivityCtx,
	input: &InsertAndSendCommandsInput,
) -> Result<()> {
	let activity_started = Instant::now();

	let hop_started = Instant::now();
	let mut state = ctx.state::<State>()?;
	log_slow_actor_command_hop(
		input.actor_id,
		input.runner_id,
		"insert_and_send_commands.state_read",
		hop_started.elapsed(),
	);

	let hop_started = Instant::now();
	let runner_state = state.runner_state.get_or_insert_default();
	let old_last_command_idx = runner_state.last_command_idx;
	runner_state.last_command_idx += input.commands.len() as i64;
	log_slow_actor_command_hop(
		input.actor_id,
		input.runner_id,
		"insert_and_send_commands.state_update",
		hop_started.elapsed(),
	);

	// This does not have to be part of its own activity because the txn is idempotent
	let last_command_idx = runner_state.last_command_idx;
	let hop_started = Instant::now();
	let tx_attempts = Arc::new(AtomicUsize::new(0));
	let tx_inner_duration_ms = Arc::new(AtomicU64::new(0));
	let tx_attempts_for_closure = tx_attempts.clone();
	let tx_inner_duration_ms_for_closure = tx_inner_duration_ms.clone();
	ctx.udb()?
		.run(|tx| {
			tx_attempts_for_closure.fetch_add(1, Ordering::AcqRel);
			let tx_inner_duration_ms = tx_inner_duration_ms_for_closure.clone();

			async move {
				let attempt_started = Instant::now();
				let result = async move {
					let tx = tx.with_subspace(keys::subspace());

					tx.write(
						&keys::runner::ActorLastCommandIdxKey::new(
							input.runner_id,
							input.actor_id,
							input.generation,
						),
						last_command_idx,
					)?;

					for (i, command) in input.commands.iter().enumerate() {
						tx.write(
							&keys::runner::ActorCommandKey::new(
								input.runner_id,
								input.actor_id,
								input.generation,
								old_last_command_idx + i as i64 + 1,
							),
							match command {
								protocol::mk2::Command::CommandStartActor(x) => {
									protocol::mk2::ActorCommandKeyData::CommandStartActor(x.clone())
								}
								protocol::mk2::Command::CommandStopActor => {
									protocol::mk2::ActorCommandKeyData::CommandStopActor
								}
							},
						)?;
					}

					Ok(())
				}
				.await;
				tx_inner_duration_ms.fetch_add(
					attempt_started.elapsed().as_millis() as u64,
					Ordering::AcqRel,
				);
				result
			}
		})
		.custom_instrument(tracing::info_span!("actor_insert_commands_tx"))
		.await?;
	let tx_duration = hop_started.elapsed();
	let command_attempts = tx_attempts.load(Ordering::Acquire);
	let tx_inner_duration_ms = tx_inner_duration_ms.load(Ordering::Acquire);
	let tx_commit_retry_duration_ms =
		(tx_duration.as_millis() as u64).saturating_sub(tx_inner_duration_ms);
	log_slow_actor_command_tx_hop(
		input.actor_id,
		input.runner_id,
		"insert_and_send_commands.udb_run",
		tx_duration,
		command_attempts,
		tx_inner_duration_ms,
		tx_commit_retry_duration_ms,
	);

	let hop_started = Instant::now();
	let receiver_subject =
		crate::pubsub_subjects::RunnerReceiverSubject::new(input.runner_id).to_string();

	let message_serialized =
		versioned::ToRunnerMk2::wrap_latest(protocol::mk2::ToRunner::ToClientCommands(
			input
				.commands
				.iter()
				.enumerate()
				.map(|(i, command)| protocol::mk2::CommandWrapper {
					checkpoint: protocol::mk2::ActorCheckpoint {
						actor_id: input.actor_id.to_string(),
						generation: input.generation,
						index: old_last_command_idx + i as i64 + 1,
					},
					inner: command.clone(),
				})
				.collect(),
		))
		.serialize_with_embedded_version(PROTOCOL_MK2_VERSION)?;
	log_slow_actor_command_hop(
		input.actor_id,
		input.runner_id,
		"insert_and_send_commands.serialize",
		hop_started.elapsed(),
	);

	let hop_started = Instant::now();
	ctx.ups()?
		.publish(&receiver_subject, &message_serialized, PublishOpts::one())
		.await?;
	log_slow_actor_command_hop(
		input.actor_id,
		input.runner_id,
		"insert_and_send_commands.ups_publish",
		hop_started.elapsed(),
	);
	log_slow_actor_command_hop(
		input.actor_id,
		input.runner_id,
		"insert_and_send_commands.activity_body",
		activity_started.elapsed(),
	);

	Ok(())
}

#[derive(Debug, Serialize, Deserialize, Hash)]
pub struct SendMessagesToRunnerInput {
	pub runner_id: Id,
	pub messages: Vec<protocol::mk2::ToRunner>,
}

#[activity(SendMessagesToRunner)]
pub async fn send_messages_to_runner(
	ctx: &ActivityCtx,
	input: &SendMessagesToRunnerInput,
) -> Result<()> {
	let receiver_subject =
		crate::pubsub_subjects::RunnerReceiverSubject::new(input.runner_id).to_string();

	for message in &input.messages {
		let message_serialized = versioned::ToRunnerMk2::wrap_latest(message.clone())
			.serialize_with_embedded_version(PROTOCOL_MK2_VERSION)?;

		ctx.ups()?
			.publish(&receiver_subject, &message_serialized, PublishOpts::one())
			.await?;
	}

	Ok(())
}

#[derive(Debug, Serialize, Deserialize, Hash)]
pub struct CheckRunnersStubInput {}

#[activity(CheckRunnersStub)]
pub async fn check_runners(ctx: &ActivityCtx, input: &CheckRunnersStubInput) -> Result<()> {
	unreachable!();
}

#[derive(Debug, Serialize, Deserialize, Hash)]
pub struct SetFailureReasonInput {
	pub failure_reason: FailureReason,
}

/// Sets the failure reason on the actor workflow state.
#[activity(SetFailureReason)]
pub async fn set_failure_reason(ctx: &ActivityCtx, input: &SetFailureReasonInput) -> Result<()> {
	let mut state = ctx.state::<State>()?;

	// Runner-related errors are never overwritten, as they represent the root cause of the failure
	// and should not be masked by subsequent errors like `Crashed`.
	if let Some(existing) = &state.failure_reason
		&& existing.is_runner_failure()
	{
		tracing::debug!(
			?existing,
			new=?input.failure_reason,
			"preserving existing runner failure error"
		);
		return Ok(());
	}

	state.failure_reason = Some(input.failure_reason.clone());
	Ok(())
}

#[derive(Debug, Serialize, Deserialize, Hash)]
pub struct RecordEventMetricsInput {
	pub namespace_id: Id,
	pub name: String,
	pub alarms_set: usize,
}

#[activity(RecordEventMetrics)]
pub async fn record_event_metrics(
	ctx: &ActivityCtx,
	input: &RecordEventMetricsInput,
) -> Result<()> {
	ctx.udb()?
		.run(|tx| async move {
			let tx = tx.with_subspace(keys::subspace());

			namespace::keys::metric::inc(
				&tx.with_subspace(namespace::keys::subspace()),
				input.namespace_id,
				namespace::keys::metric::Metric::AlarmsSet(input.name.clone()),
				input.alarms_set as i64,
			);

			Ok(())
		})
		.await?;

	Ok(())
}
