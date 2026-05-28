use std::cmp::Ordering;

use gas::prelude::Id;
use serde::{Deserialize, Serialize};

pub const DEFAULT_WORKER_LANE: &str = "default";

#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct WorkerLane {
	name: String,
}

impl WorkerLane {
	pub fn new(name: impl Into<String>) -> Self {
		Self { name: name.into() }
	}

	pub fn as_str(&self) -> &str {
		&self.name
	}
}

impl Default for WorkerLane {
	fn default() -> Self {
		Self::new(DEFAULT_WORKER_LANE)
	}
}

impl From<&str> for WorkerLane {
	fn from(value: &str) -> Self {
		Self::new(value)
	}
}

impl From<String> for WorkerLane {
	fn from(value: String) -> Self {
		Self::new(value)
	}
}

pub fn worker_lane_from_hint(lane_hint: Option<&str>) -> WorkerLane {
	lane_hint.map(WorkerLane::from).unwrap_or_default()
}

pub fn actor_placement_key(
	namespace_id: Id,
	name: &str,
	key: Option<&str>,
	actor_id: Id,
) -> Vec<u8> {
	match key {
		Some(key) => format!("key:{namespace_id}:{name}:{key}").into_bytes(),
		None => format!("actor:{actor_id}").into_bytes(),
	}
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkerLaneSpec {
	pub lane: WorkerLane,
	pub max_slots: u32,
	pub prewarm_slots: u32,
}

impl WorkerLaneSpec {
	pub fn new(lane: impl Into<WorkerLane>, max_slots: u32) -> Self {
		Self {
			lane: lane.into(),
			max_slots,
			prewarm_slots: 0,
		}
	}
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkerLaneCandidate {
	pub runner_id: Id,
	pub runner_workflow_id: Id,
	pub lane: WorkerLane,
	pub version: u32,
	pub remaining_slots: u32,
	pub total_slots: u32,
	pub last_ping_ts: i64,
	pub protocol_version: Option<u16>,
}

impl WorkerLaneCandidate {
	pub fn remaining_millislots(&self) -> u32 {
		millislots(self.remaining_slots, self.total_slots)
	}

	fn has_capacity(&self) -> bool {
		self.remaining_slots > 0 && self.total_slots > 0
	}
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WorkerLaneEndpointCandidate {
	pub endpoint_key: String,
	pub lane: WorkerLane,
	pub version: u32,
	pub last_ping_ts: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerLanePlacementInput<'a> {
	pub actor_key: &'a [u8],
	pub lane: &'a WorkerLane,
	pub now_ts: i64,
	pub runner_eligible_threshold: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkerLanePlacement {
	Selected(WorkerLaneAssignment),
	Pending(WorkerLanePending),
}

impl WorkerLanePlacement {
	pub fn selected(&self) -> Option<&WorkerLaneAssignment> {
		match self {
			WorkerLanePlacement::Selected(assignment) => Some(assignment),
			WorkerLanePlacement::Pending(_) => None,
		}
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkerLaneEndpointPlacement {
	Selected(WorkerLaneEndpointAssignment),
	Pending(WorkerLanePending),
}

impl WorkerLaneEndpointPlacement {
	pub fn selected(&self) -> Option<&WorkerLaneEndpointAssignment> {
		match self {
			WorkerLaneEndpointPlacement::Selected(assignment) => Some(assignment),
			WorkerLaneEndpointPlacement::Pending(_) => None,
		}
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerLaneAssignment {
	pub runner_id: Id,
	pub runner_workflow_id: Id,
	pub lane: WorkerLane,
	pub version: u32,
	pub remaining_slots_before: u32,
	pub remaining_slots_after: u32,
	pub remaining_millislots_after: u32,
	pub total_slots: u32,
	pub protocol_version: Option<u16>,
}

impl WorkerLaneAssignment {
	fn from_candidate(candidate: &WorkerLaneCandidate) -> Self {
		let remaining_slots_after = candidate.remaining_slots.saturating_sub(1);

		Self {
			runner_id: candidate.runner_id,
			runner_workflow_id: candidate.runner_workflow_id,
			lane: candidate.lane.clone(),
			version: candidate.version,
			remaining_slots_before: candidate.remaining_slots,
			remaining_slots_after,
			remaining_millislots_after: millislots(remaining_slots_after, candidate.total_slots),
			total_slots: candidate.total_slots,
			protocol_version: candidate.protocol_version,
		}
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerLaneEndpointAssignment {
	pub endpoint_key: String,
	pub lane: WorkerLane,
	pub version: u32,
}

impl WorkerLaneEndpointAssignment {
	fn from_candidate(candidate: &WorkerLaneEndpointCandidate) -> Self {
		Self {
			endpoint_key: candidate.endpoint_key.clone(),
			lane: candidate.lane.clone(),
			version: candidate.version,
		}
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerLanePending {
	pub lane: WorkerLane,
	pub reason: WorkerLanePendingReason,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerLanePendingReason {
	NoCandidates,
	NoCapacity,
	StaleRunners,
}

pub fn place_actor_in_worker_lane(
	input: WorkerLanePlacementInput<'_>,
	candidates: &[WorkerLaneCandidate],
) -> WorkerLanePlacement {
	let Some(highest_version) = candidates
		.iter()
		.filter(|candidate| candidate.lane == *input.lane)
		.map(|candidate| candidate.version)
		.max()
	else {
		return pending(input.lane, WorkerLanePendingReason::NoCandidates);
	};

	let highest_version_candidates = candidates
		.iter()
		.filter(|candidate| candidate.lane == *input.lane && candidate.version == highest_version);

	if !highest_version_candidates
		.clone()
		.any(WorkerLaneCandidate::has_capacity)
	{
		return pending(input.lane, WorkerLanePendingReason::NoCapacity);
	}

	let ping_threshold_ts = input.now_ts.saturating_sub(input.runner_eligible_threshold);
	let Some(selected) = highest_version_candidates
		.filter(|candidate| candidate.has_capacity() && candidate.last_ping_ts >= ping_threshold_ts)
		.max_by(|left, right| compare_candidate_rank(&input, left, right))
	else {
		return pending(input.lane, WorkerLanePendingReason::StaleRunners);
	};

	WorkerLanePlacement::Selected(WorkerLaneAssignment::from_candidate(selected))
}

pub fn place_actor_on_worker_endpoint(
	input: WorkerLanePlacementInput<'_>,
	candidates: &[WorkerLaneEndpointCandidate],
) -> WorkerLaneEndpointPlacement {
	let Some(highest_version) = candidates
		.iter()
		.filter(|candidate| candidate.lane == *input.lane)
		.map(|candidate| candidate.version)
		.max()
	else {
		return endpoint_pending(input.lane, WorkerLanePendingReason::NoCandidates);
	};

	let highest_version_candidates = candidates
		.iter()
		.filter(|candidate| candidate.lane == *input.lane && candidate.version == highest_version);

	let ping_threshold_ts = input.now_ts.saturating_sub(input.runner_eligible_threshold);
	let Some(selected) = highest_version_candidates
		.filter(|candidate| candidate.last_ping_ts >= ping_threshold_ts)
		.max_by(|left, right| compare_endpoint_rank(&input, left, right))
	else {
		return endpoint_pending(input.lane, WorkerLanePendingReason::StaleRunners);
	};

	WorkerLaneEndpointPlacement::Selected(WorkerLaneEndpointAssignment::from_candidate(selected))
}

fn pending(lane: &WorkerLane, reason: WorkerLanePendingReason) -> WorkerLanePlacement {
	WorkerLanePlacement::Pending(WorkerLanePending {
		lane: lane.clone(),
		reason,
	})
}

fn endpoint_pending(
	lane: &WorkerLane,
	reason: WorkerLanePendingReason,
) -> WorkerLaneEndpointPlacement {
	WorkerLaneEndpointPlacement::Pending(WorkerLanePending {
		lane: lane.clone(),
		reason,
	})
}

fn compare_candidate_rank(
	input: &WorkerLanePlacementInput<'_>,
	left: &WorkerLaneCandidate,
	right: &WorkerLaneCandidate,
) -> Ordering {
	candidate_rank(input, left)
		.cmp(&candidate_rank(input, right))
		.then_with(|| {
			left.remaining_millislots()
				.cmp(&right.remaining_millislots())
		})
		.then_with(|| left.last_ping_ts.cmp(&right.last_ping_ts))
		.then_with(|| left.runner_id.to_string().cmp(&right.runner_id.to_string()))
}

fn compare_endpoint_rank(
	input: &WorkerLanePlacementInput<'_>,
	left: &WorkerLaneEndpointCandidate,
	right: &WorkerLaneEndpointCandidate,
) -> Ordering {
	endpoint_rank(input, left)
		.cmp(&endpoint_rank(input, right))
		.then_with(|| left.last_ping_ts.cmp(&right.last_ping_ts))
		.then_with(|| left.endpoint_key.cmp(&right.endpoint_key))
}

fn candidate_rank(input: &WorkerLanePlacementInput<'_>, candidate: &WorkerLaneCandidate) -> u128 {
	worker_key_rank(
		input.actor_key,
		input.lane.as_str(),
		&candidate.runner_id.to_string(),
		candidate.version,
		candidate.remaining_millislots(),
	)
}

fn endpoint_rank(
	input: &WorkerLanePlacementInput<'_>,
	candidate: &WorkerLaneEndpointCandidate,
) -> u128 {
	worker_key_rank(
		input.actor_key,
		input.lane.as_str(),
		&candidate.endpoint_key,
		candidate.version,
		1,
	)
}

fn worker_key_rank(
	actor_key: &[u8],
	lane: &str,
	worker_key: &str,
	version: u32,
	weight: u32,
) -> u128 {
	let hash = placement_hash(actor_key, lane, worker_key, version);
	u128::from(hash) * u128::from(weight.max(1))
}

fn millislots(remaining_slots: u32, total_slots: u32) -> u32 {
	if total_slots == 0 {
		return 0;
	}

	let value = (u64::from(remaining_slots) * 1000) / u64::from(total_slots);
	value.min(u64::from(u32::MAX)) as u32
}

fn placement_hash(actor_key: &[u8], lane: &str, worker_key: &str, version: u32) -> u64 {
	let mut hash = FNV_OFFSET;

	hash = update_hash_with_bytes(hash, actor_key);
	hash = update_hash_with_bytes(hash, lane.as_bytes());
	hash = update_hash_with_bytes(hash, worker_key.as_bytes());
	hash = update_hash_with_bytes(hash, &version.to_le_bytes());
	hash
}

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn update_hash_with_bytes(mut hash: u64, bytes: &[u8]) -> u64 {
	for byte in (bytes.len() as u64).to_le_bytes() {
		hash ^= u64::from(byte);
		hash = hash.wrapping_mul(FNV_PRIME);
	}

	for byte in bytes {
		hash ^= u64::from(*byte);
		hash = hash.wrapping_mul(FNV_PRIME);
	}

	hash
}
