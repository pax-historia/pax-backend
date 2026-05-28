use std::{
	collections::HashMap,
	hash::{Hash, Hasher},
	sync::RwLock,
	time::{Duration, Instant},
};

use anyhow::{Context, Result};
use gas::prelude::Id;
use serde::{Deserialize, Serialize};
use universalpubsub::{PubSub, PublishOpts};

const DEFAULT_SHARD_COUNT: usize = 64;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum RoutingTarget {
	Runner { runner_id: Id },
	Envoy { namespace_id: Id, envoy_key: String },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RoutingStatus {
	Ready,
	Hibernating,
	Stale,
	Removed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RoutingSnapshot {
	pub actor_id: Id,
	pub generation: u64,
	pub status: RoutingStatus,
	pub target: Option<RoutingTarget>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RoutingLookup {
	Ready(RoutingSnapshot),
	NotReady(RoutingSnapshot),
	Stale(RoutingSnapshot),
	Missing,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum RoutingDelta {
	Ready {
		actor_id: Id,
		generation: u64,
		target: RoutingTarget,
	},
	Hibernating {
		actor_id: Id,
		generation: u64,
		target: Option<RoutingTarget>,
	},
	Stale {
		actor_id: Id,
		generation: u64,
		target: Option<RoutingTarget>,
	},
	Removed {
		actor_id: Id,
		generation: u64,
	},
	TargetHeartbeat {
		target: RoutingTarget,
	},
}

impl RoutingDelta {
	pub fn to_payload(&self) -> Result<Vec<u8>> {
		serde_json::to_vec(self).context("serialize routing directory delta")
	}

	pub fn from_payload(payload: &[u8]) -> Result<Self> {
		serde_json::from_slice(payload).context("deserialize routing directory delta")
	}
}

pub async fn publish_delta(ups: &PubSub, delta: RoutingDelta) -> Result<()> {
	let payload = delta.to_payload()?;
	ups.publish(
		&crate::pubsub_subjects::RoutingDirectorySubject.to_string(),
		&payload,
		PublishOpts::broadcast(),
	)
	.await
	.context("publish routing directory delta")?;

	Ok(())
}

pub async fn publish_delta_best_effort(ups: &PubSub, delta: RoutingDelta) {
	if let Err(err) = publish_delta(ups, delta).await {
		tracing::warn!(?err, "failed to publish routing directory delta");
	}
}

#[derive(Debug)]
pub struct RoutingDirectory {
	shards: Vec<RwLock<HashMap<Id, RoutingEntry>>>,
	target_liveness: Vec<RwLock<HashMap<RoutingTarget, Instant>>>,
}

impl RoutingDirectory {
	pub fn new() -> Self {
		Self::with_shards(DEFAULT_SHARD_COUNT)
	}

	pub fn with_shards(shard_count: usize) -> Self {
		assert!(
			shard_count > 0,
			"routing directory shard count must be positive"
		);

		Self {
			shards: (0..shard_count)
				.map(|_| RwLock::new(HashMap::new()))
				.collect(),
			target_liveness: (0..shard_count)
				.map(|_| RwLock::new(HashMap::new()))
				.collect(),
		}
	}

	pub fn apply_delta(&self, delta: RoutingDelta) -> bool {
		self.apply_delta_at(delta, Instant::now())
	}

	pub fn mark_stale(&self, actor_id: Id) -> bool {
		self.mark_stale_at(actor_id, Instant::now())
	}

	pub fn mark_stale_at(&self, actor_id: Id, observed_at: Instant) -> bool {
		let mut shard = self.shard_for(actor_id).write().unwrap();
		let Some(entry) = shard.get_mut(&actor_id) else {
			return false;
		};

		if entry.status == RoutingStatus::Removed {
			return false;
		}

		entry.status = RoutingStatus::Stale;
		entry.observed_at = observed_at;
		true
	}

	pub fn apply_delta_at(&self, delta: RoutingDelta, observed_at: Instant) -> bool {
		let (actor_id, generation, target, entry) = match delta {
			RoutingDelta::Ready {
				actor_id,
				generation,
				target,
			} => {
				let liveness_target = target.clone();
				(
					actor_id,
					generation,
					Some(liveness_target),
					RoutingEntry {
						actor_id,
						generation,
						status: RoutingStatus::Ready,
						target: Some(target),
						observed_at,
					},
				)
			}
			RoutingDelta::Hibernating {
				actor_id,
				generation,
				target,
			} => {
				let liveness_target = target.clone();
				(
					actor_id,
					generation,
					liveness_target,
					RoutingEntry {
						actor_id,
						generation,
						status: RoutingStatus::Hibernating,
						target,
						observed_at,
					},
				)
			}
			RoutingDelta::Stale {
				actor_id,
				generation,
				target,
			} => {
				let liveness_target = target.clone();
				(
					actor_id,
					generation,
					liveness_target,
					RoutingEntry {
						actor_id,
						generation,
						status: RoutingStatus::Stale,
						target,
						observed_at,
					},
				)
			}
			RoutingDelta::Removed {
				actor_id,
				generation,
			} => (
				actor_id,
				generation,
				None,
				RoutingEntry {
					actor_id,
					generation,
					status: RoutingStatus::Removed,
					target: None,
					observed_at,
				},
			),
			RoutingDelta::TargetHeartbeat { target } => {
				self.observe_target(target, observed_at);
				return true;
			}
		};

		let mut shard = self.shard_for(actor_id).write().unwrap();

		if let Some(existing) = shard.get(&actor_id) {
			if existing.generation > generation {
				return false;
			}

			if existing.status == RoutingStatus::Removed && existing.generation == generation {
				return false;
			}
		}

		shard.insert(actor_id, entry);

		if let Some(target) = target {
			self.observe_target(target, observed_at);
		}

		true
	}

	pub fn lookup(&self, actor_id: Id, now: Instant, stale_after: Duration) -> RoutingLookup {
		let (snapshot, observed_at) = {
			let shard = self.shard_for(actor_id).read().unwrap();
			let Some(entry) = shard.get(&actor_id) else {
				return RoutingLookup::Missing;
			};

			if entry.status == RoutingStatus::Removed {
				return RoutingLookup::Missing;
			}

			(entry.snapshot(), entry.observed_at)
		};

		let observed_at = snapshot
			.target
			.as_ref()
			.and_then(|target| self.target_observed_at(target))
			.map(|target_observed_at| target_observed_at.max(observed_at))
			.unwrap_or(observed_at);

		if now.saturating_duration_since(observed_at) > stale_after {
			return RoutingLookup::Stale(snapshot);
		}

		match snapshot.status {
			RoutingStatus::Ready if snapshot.target.is_some() => RoutingLookup::Ready(snapshot),
			RoutingStatus::Ready | RoutingStatus::Hibernating => RoutingLookup::NotReady(snapshot),
			RoutingStatus::Stale => RoutingLookup::Stale(snapshot),
			RoutingStatus::Removed => RoutingLookup::Missing,
		}
	}

	pub fn len(&self) -> usize {
		self.shards
			.iter()
			.map(|shard| shard.read().unwrap().len())
			.sum()
	}

	pub fn is_empty(&self) -> bool {
		self.len() == 0
	}

	fn shard_for(&self, actor_id: Id) -> &RwLock<HashMap<Id, RoutingEntry>> {
		let mut hasher = std::collections::hash_map::DefaultHasher::new();
		actor_id.hash(&mut hasher);
		&self.shards[hasher.finish() as usize % self.shards.len()]
	}

	fn shard_for_target(&self, target: &RoutingTarget) -> &RwLock<HashMap<RoutingTarget, Instant>> {
		let mut hasher = std::collections::hash_map::DefaultHasher::new();
		target.hash(&mut hasher);
		&self.target_liveness[hasher.finish() as usize % self.target_liveness.len()]
	}

	fn observe_target(&self, target: RoutingTarget, observed_at: Instant) {
		let mut shard = self.shard_for_target(&target).write().unwrap();
		match shard.get_mut(&target) {
			Some(existing) if *existing >= observed_at => {}
			Some(existing) => *existing = observed_at,
			None => {
				shard.insert(target, observed_at);
			}
		}
	}

	fn target_observed_at(&self, target: &RoutingTarget) -> Option<Instant> {
		self.shard_for_target(target)
			.read()
			.unwrap()
			.get(target)
			.copied()
	}
}

impl Default for RoutingDirectory {
	fn default() -> Self {
		Self::new()
	}
}

#[derive(Clone, Debug)]
struct RoutingEntry {
	actor_id: Id,
	generation: u64,
	status: RoutingStatus,
	target: Option<RoutingTarget>,
	observed_at: Instant,
}

impl RoutingEntry {
	fn snapshot(&self) -> RoutingSnapshot {
		RoutingSnapshot {
			actor_id: self.actor_id,
			generation: self.generation,
			status: self.status,
			target: self.target.clone(),
		}
	}
}
