use std::time::{Duration, Instant};

use gas::prelude::Id;
use pegboard::routing_directory::{
	RoutingDelta, RoutingDirectory, RoutingLookup, RoutingSnapshot, RoutingStatus, RoutingTarget,
};

fn id(label: u16) -> Id {
	Id::new_v1(label)
}

fn envoy_target() -> RoutingTarget {
	RoutingTarget::Envoy {
		namespace_id: id(10),
		envoy_key: "envoy-a".to_owned(),
	}
}

fn runner_target() -> RoutingTarget {
	RoutingTarget::Runner { runner_id: id(11) }
}

#[test]
fn ready_delta_is_returned_as_hot_route() {
	let directory = RoutingDirectory::new();
	let actor_id = id(20);
	let now = Instant::now();
	let target = envoy_target();

	assert!(directory.apply_delta_at(
		RoutingDelta::Ready {
			actor_id,
			generation: 1,
			target: target.clone(),
		},
		now,
	));

	assert_eq!(
		directory.lookup(
			actor_id,
			now + Duration::from_millis(5),
			Duration::from_secs(30)
		),
		RoutingLookup::Ready(RoutingSnapshot {
			actor_id,
			generation: 1,
			status: RoutingStatus::Ready,
			target: Some(target),
		})
	);
}

#[test]
fn stale_ready_entry_is_not_returned_as_hot_route() {
	let directory = RoutingDirectory::new();
	let actor_id = id(21);
	let now = Instant::now();
	let target = runner_target();

	assert!(directory.apply_delta_at(
		RoutingDelta::Ready {
			actor_id,
			generation: 7,
			target: target.clone(),
		},
		now,
	));

	assert_eq!(
		directory.lookup(
			actor_id,
			now + Duration::from_secs(31),
			Duration::from_secs(30)
		),
		RoutingLookup::Stale(RoutingSnapshot {
			actor_id,
			generation: 7,
			status: RoutingStatus::Ready,
			target: Some(target),
		})
	);
}

#[test]
fn mark_stale_forces_ready_route_to_fall_back_until_next_ready_delta() {
	let directory = RoutingDirectory::new();
	let actor_id = id(29);
	let runner_id = id(30);
	let target = RoutingTarget::Runner { runner_id };
	let now = Instant::now();

	assert!(directory.apply_delta_at(
		RoutingDelta::Ready {
			actor_id,
			generation: 1,
			target: target.clone(),
		},
		now,
	));
	assert!(directory.mark_stale_at(actor_id, now + Duration::from_secs(1)));
	assert_eq!(
		directory.lookup(
			actor_id,
			now + Duration::from_secs(2),
			Duration::from_secs(30),
		),
		RoutingLookup::Stale(RoutingSnapshot {
			actor_id,
			generation: 1,
			status: RoutingStatus::Stale,
			target: Some(target.clone()),
		})
	);

	assert!(directory.apply_delta_at(
		RoutingDelta::Ready {
			actor_id,
			generation: 1,
			target: target.clone(),
		},
		now + Duration::from_secs(3),
	));
	assert_eq!(
		directory.lookup(
			actor_id,
			now + Duration::from_secs(4),
			Duration::from_secs(30),
		),
		RoutingLookup::Ready(RoutingSnapshot {
			actor_id,
			generation: 1,
			status: RoutingStatus::Ready,
			target: Some(target),
		})
	);
}

#[test]
fn hibernating_delta_is_not_a_ready_hot_route() {
	let directory = RoutingDirectory::new();
	let actor_id = id(22);
	let now = Instant::now();
	let target = envoy_target();

	assert!(directory.apply_delta_at(
		RoutingDelta::Hibernating {
			actor_id,
			generation: 3,
			target: Some(target.clone()),
		},
		now,
	));

	assert_eq!(
		directory.lookup(actor_id, now, Duration::from_secs(30)),
		RoutingLookup::NotReady(RoutingSnapshot {
			actor_id,
			generation: 3,
			status: RoutingStatus::Hibernating,
			target: Some(target),
		})
	);
}

#[test]
fn newer_remove_blocks_late_older_ready_delta() {
	let directory = RoutingDirectory::with_shards(4);
	let actor_id = id(23);
	let now = Instant::now();

	assert!(directory.apply_delta_at(
		RoutingDelta::Removed {
			actor_id,
			generation: 5,
		},
		now,
	));
	assert!(!directory.apply_delta_at(
		RoutingDelta::Ready {
			actor_id,
			generation: 4,
			target: runner_target(),
		},
		now,
	));
	assert_eq!(
		directory.lookup(actor_id, now, Duration::from_secs(30)),
		RoutingLookup::Missing
	);

	let target = runner_target();
	assert!(directory.apply_delta_at(
		RoutingDelta::Ready {
			actor_id,
			generation: 6,
			target: target.clone(),
		},
		now,
	));
	assert_eq!(
		directory.lookup(actor_id, now, Duration::from_secs(30)),
		RoutingLookup::Ready(RoutingSnapshot {
			actor_id,
			generation: 6,
			status: RoutingStatus::Ready,
			target: Some(target),
		})
	);
}

#[test]
fn remove_tombstone_blocks_same_generation_ready_delta() {
	let directory = RoutingDirectory::new();
	let actor_id = id(24);
	let now = Instant::now();

	assert!(directory.apply_delta_at(
		RoutingDelta::Removed {
			actor_id,
			generation: 9,
		},
		now,
	));
	assert!(!directory.apply_delta_at(
		RoutingDelta::Ready {
			actor_id,
			generation: 9,
			target: envoy_target(),
		},
		now,
	));
	assert_eq!(
		directory.lookup(actor_id, now, Duration::from_secs(30)),
		RoutingLookup::Missing
	);
}

#[test]
fn target_heartbeat_refreshes_ready_route_without_actor_delta() {
	let directory = RoutingDirectory::new();
	let actor_id = id(25);
	let runner_id = id(26);
	let target = RoutingTarget::Runner { runner_id };
	let now = Instant::now();

	assert!(directory.apply_delta_at(
		RoutingDelta::Ready {
			actor_id,
			generation: 1,
			target: target.clone(),
		},
		now,
	));
	assert!(directory.apply_delta_at(
		RoutingDelta::TargetHeartbeat {
			target: target.clone(),
		},
		now + Duration::from_secs(25),
	));

	assert_eq!(
		directory.lookup(
			actor_id,
			now + Duration::from_secs(31),
			Duration::from_secs(30),
		),
		RoutingLookup::Ready(RoutingSnapshot {
			actor_id,
			generation: 1,
			status: RoutingStatus::Ready,
			target: Some(target.clone()),
		})
	);
	assert_eq!(
		directory.lookup(
			actor_id,
			now + Duration::from_secs(56),
			Duration::from_secs(30),
		),
		RoutingLookup::Stale(RoutingSnapshot {
			actor_id,
			generation: 1,
			status: RoutingStatus::Ready,
			target: Some(target),
		})
	);
}

#[test]
fn older_target_heartbeat_does_not_regress_liveness() {
	let directory = RoutingDirectory::new();
	let actor_id = id(27);
	let runner_id = id(28);
	let target = RoutingTarget::Runner { runner_id };
	let now = Instant::now();

	assert!(directory.apply_delta_at(
		RoutingDelta::Ready {
			actor_id,
			generation: 1,
			target: target.clone(),
		},
		now,
	));
	assert!(directory.apply_delta_at(
		RoutingDelta::TargetHeartbeat {
			target: target.clone(),
		},
		now + Duration::from_secs(25),
	));
	assert!(directory.apply_delta_at(
		RoutingDelta::TargetHeartbeat {
			target: target.clone(),
		},
		now + Duration::from_secs(5),
	));

	assert_eq!(
		directory.lookup(
			actor_id,
			now + Duration::from_secs(31),
			Duration::from_secs(30),
		),
		RoutingLookup::Ready(RoutingSnapshot {
			actor_id,
			generation: 1,
			status: RoutingStatus::Ready,
			target: Some(target),
		})
	);
}

#[test]
fn routing_delta_payload_round_trips() {
	let delta = RoutingDelta::TargetHeartbeat {
		target: envoy_target(),
	};
	let payload = delta.to_payload().expect("serialize delta");

	assert_eq!(
		RoutingDelta::from_payload(&payload).expect("deserialize delta"),
		delta
	);
}
