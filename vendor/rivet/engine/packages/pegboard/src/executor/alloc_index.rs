use crate::keys;

use super::{WorkerLane, WorkerLaneAssignment, WorkerLaneCandidate};

// Keep single-runner setup fan-in from repeatedly selecting the same allocation key.
pub const ALLOC_INDEX_BUCKET_COUNT: u16 = 512;

#[derive(Debug)]
pub enum RunnerAllocIndexKey {
	Default(keys::ns::RunnerAllocIdxKey),
	Lane(keys::ns::RunnerLaneAllocIdxKey),
	BucketDefault(keys::ns::RunnerAllocBucketIdxKey),
	BucketLane(keys::ns::RunnerLaneAllocBucketIdxKey),
}

#[derive(Debug)]
pub struct RunnerAllocIndexCandidate {
	pub key: RunnerAllocIndexKey,
	pub data: rivet_data::converted::RunnerAllocIdxKeyData,
}

impl RunnerAllocIndexCandidate {
	pub fn from_default(
		key: keys::ns::RunnerAllocIdxKey,
		data: rivet_data::converted::RunnerAllocIdxKeyData,
	) -> Self {
		Self {
			key: RunnerAllocIndexKey::Default(key),
			data,
		}
	}

	pub fn from_lane(
		key: keys::ns::RunnerLaneAllocIdxKey,
		data: rivet_data::converted::RunnerAllocIdxKeyData,
	) -> Self {
		Self {
			key: RunnerAllocIndexKey::Lane(key),
			data,
		}
	}

	pub fn from_bucket_default(
		key: keys::ns::RunnerAllocBucketIdxKey,
		data: rivet_data::converted::RunnerAllocIdxKeyData,
	) -> Self {
		Self {
			key: RunnerAllocIndexKey::BucketDefault(key),
			data,
		}
	}

	pub fn from_bucket_lane(
		key: keys::ns::RunnerLaneAllocBucketIdxKey,
		data: rivet_data::converted::RunnerAllocIdxKeyData,
	) -> Self {
		Self {
			key: RunnerAllocIndexKey::BucketLane(key),
			data,
		}
	}

	pub fn version(&self) -> u32 {
		match &self.key {
			RunnerAllocIndexKey::Default(key) => key.version,
			RunnerAllocIndexKey::Lane(key) => key.version,
			RunnerAllocIndexKey::BucketDefault(key) => key.version,
			RunnerAllocIndexKey::BucketLane(key) => key.version,
		}
	}

	pub fn remaining_millislots(&self) -> u32 {
		match &self.key {
			RunnerAllocIndexKey::Default(key) => key.remaining_millislots,
			RunnerAllocIndexKey::Lane(key) => key.remaining_millislots,
			RunnerAllocIndexKey::BucketDefault(key) => key.remaining_millislots,
			RunnerAllocIndexKey::BucketLane(key) => key.remaining_millislots,
		}
	}

	pub fn last_ping_ts(&self) -> i64 {
		match &self.key {
			RunnerAllocIndexKey::Default(key) => key.last_ping_ts,
			RunnerAllocIndexKey::Lane(key) => key.last_ping_ts,
			RunnerAllocIndexKey::BucketDefault(key) => key.last_ping_ts,
			RunnerAllocIndexKey::BucketLane(key) => key.last_ping_ts,
		}
	}

	pub fn runner_id(&self) -> gas::prelude::Id {
		match &self.key {
			RunnerAllocIndexKey::Default(key) => key.runner_id,
			RunnerAllocIndexKey::Lane(key) => key.runner_id,
			RunnerAllocIndexKey::BucketDefault(key) => key.runner_id,
			RunnerAllocIndexKey::BucketLane(key) => key.runner_id,
		}
	}

	pub fn lane(&self) -> WorkerLane {
		match &self.key {
			RunnerAllocIndexKey::Default(_) => WorkerLane::default(),
			RunnerAllocIndexKey::Lane(key) => WorkerLane::from(key.lane.clone()),
			RunnerAllocIndexKey::BucketDefault(_) => WorkerLane::default(),
			RunnerAllocIndexKey::BucketLane(key) => WorkerLane::from(key.lane.clone()),
		}
	}

	pub fn worker_candidate(&self) -> WorkerLaneCandidate {
		WorkerLaneCandidate {
			runner_id: self.runner_id(),
			runner_workflow_id: self.data.workflow_id,
			lane: self.lane(),
			version: self.version(),
			remaining_slots: self.data.remaining_slots,
			total_slots: self.data.total_slots,
			last_ping_ts: self.last_ping_ts(),
			protocol_version: Some(self.data.protocol_version),
		}
	}

	pub fn matches_assignment(&self, assignment: &WorkerLaneAssignment) -> bool {
		self.runner_id() == assignment.runner_id && self.version() == assignment.version
	}

	pub fn is_bucketed(&self) -> bool {
		matches!(
			&self.key,
			RunnerAllocIndexKey::BucketDefault(_) | RunnerAllocIndexKey::BucketLane(_)
		)
	}

	pub fn with_last_ping_ts(self, last_ping_ts: i64) -> Self {
		let key = match self.key {
			RunnerAllocIndexKey::Default(mut key) => {
				key.last_ping_ts = last_ping_ts;
				RunnerAllocIndexKey::Default(key)
			}
			RunnerAllocIndexKey::Lane(mut key) => {
				key.last_ping_ts = last_ping_ts;
				RunnerAllocIndexKey::Lane(key)
			}
			RunnerAllocIndexKey::BucketDefault(mut key) => {
				key.last_ping_ts = last_ping_ts;
				RunnerAllocIndexKey::BucketDefault(key)
			}
			RunnerAllocIndexKey::BucketLane(mut key) => {
				key.last_ping_ts = last_ping_ts;
				RunnerAllocIndexKey::BucketLane(key)
			}
		};

		Self {
			key,
			data: self.data,
		}
	}

	pub fn data_with_remaining(
		&self,
		remaining_slots: u32,
	) -> rivet_data::converted::RunnerAllocIdxKeyData {
		rivet_data::converted::RunnerAllocIdxKeyData {
			workflow_id: self.data.workflow_id,
			remaining_slots,
			total_slots: self.data.total_slots,
			protocol_version: self.data.protocol_version,
		}
	}

	pub fn replacement_key(&self, remaining_millislots: u32) -> RunnerAllocIndexKey {
		match &self.key {
			RunnerAllocIndexKey::Default(key) => {
				RunnerAllocIndexKey::Default(keys::ns::RunnerAllocIdxKey::new(
					key.namespace_id,
					key.name.clone(),
					key.version,
					remaining_millislots,
					key.last_ping_ts,
					key.runner_id,
				))
			}
			RunnerAllocIndexKey::Lane(key) => {
				RunnerAllocIndexKey::Lane(keys::ns::RunnerLaneAllocIdxKey::new(
					key.namespace_id,
					key.name.clone(),
					key.lane.clone(),
					key.version,
					remaining_millislots,
					key.last_ping_ts,
					key.runner_id,
				))
			}
			RunnerAllocIndexKey::BucketDefault(key) => {
				RunnerAllocIndexKey::BucketDefault(keys::ns::RunnerAllocBucketIdxKey::new(
					key.namespace_id,
					key.name.clone(),
					key.bucket,
					key.version,
					remaining_millislots,
					key.last_ping_ts,
					key.runner_id,
				))
			}
			RunnerAllocIndexKey::BucketLane(key) => {
				RunnerAllocIndexKey::BucketLane(keys::ns::RunnerLaneAllocBucketIdxKey::new(
					key.namespace_id,
					key.name.clone(),
					key.lane.clone(),
					key.bucket,
					key.version,
					remaining_millislots,
					key.last_ping_ts,
					key.runner_id,
				))
			}
		}
	}
}

pub fn alloc_bucket_for_placement_key(placement_key: &[u8]) -> u16 {
	(placement_hash(placement_key) % u64::from(ALLOC_INDEX_BUCKET_COUNT)) as u16
}

pub fn bucket_slot_capacity(total_slots: u32, bucket: u16) -> u32 {
	distribute_slots(total_slots, bucket)
}

pub fn bucket_remaining_slots(remaining_slots: u32, bucket: u16) -> u32 {
	distribute_slots(remaining_slots, bucket)
}

pub fn bucket_remaining_millislots(remaining_slots: u32, total_slots: u32) -> u32 {
	if total_slots == 0 {
		return 0;
	}

	let value = (u64::from(remaining_slots) * 1000) / u64::from(total_slots);
	value.min(u64::from(u32::MAX)) as u32
}

fn distribute_slots(slots: u32, bucket: u16) -> u32 {
	let bucket_count = u32::from(ALLOC_INDEX_BUCKET_COUNT);
	let base = slots / bucket_count;
	let remainder = slots % bucket_count;

	base + u32::from(u32::from(bucket) < remainder)
}

fn placement_hash(bytes: &[u8]) -> u64 {
	let mut hash = 0xcbf2_9ce4_8422_2325u64;

	for byte in (bytes.len() as u64).to_le_bytes() {
		hash ^= u64::from(byte);
		hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
	}

	for byte in bytes {
		hash ^= u64::from(*byte);
		hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
	}

	hash
}
