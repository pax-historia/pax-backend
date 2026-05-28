use gas::prelude::Id;
use pegboard::{
	executor::WorkerLane,
	keys,
	workflows::{actor, actor2},
};
use rivet_types::actors::CrashPolicy;
use universaldb::utils::FormalKey;

fn id(seed: u128) -> Id {
	Id::v1(uuid::Uuid::from_u128(seed), 1)
}

#[test]
fn v1_actor_input_defaults_missing_lane_hint() {
	let mut value = serde_json::to_value(actor::Input {
		actor_id: id(10),
		name: "game".to_owned(),
		key: None,
		namespace_id: id(11),
		runner_name_selector: "pool".to_owned(),
		lane_hint: Some("cpu-heavy".to_owned()),
		crash_policy: CrashPolicy::Destroy,
		input: None,
	})
	.unwrap();
	value.as_object_mut().unwrap().remove("lane_hint");

	let decoded: actor::Input = serde_json::from_value(value).unwrap();

	assert_eq!(None, decoded.lane_hint);
}

#[test]
fn v1_actor_state_resolves_missing_lane_hint_to_default_lane() {
	let mut value = serde_json::to_value(actor::State::new(
		"game".to_owned(),
		None,
		id(1),
		"pool".to_owned(),
		Some("cpu-heavy".to_owned()),
		CrashPolicy::Destroy,
		100,
	))
	.unwrap();
	value.as_object_mut().unwrap().remove("lane_hint");

	let decoded: actor::State = serde_json::from_value(value).unwrap();

	assert_eq!(None, decoded.lane_hint);
	assert_eq!(WorkerLane::default(), decoded.worker_lane());
}

#[test]
fn v1_actor_state_preserves_explicit_lane_hint() {
	let state = actor::State::new(
		"game".to_owned(),
		None,
		id(2),
		"pool".to_owned(),
		Some("cpu-heavy".to_owned()),
		CrashPolicy::Destroy,
		100,
	);

	assert_eq!(Some("cpu-heavy"), state.lane_hint.as_deref());
	assert_eq!(WorkerLane::from("cpu-heavy"), state.worker_lane());
}

#[test]
fn actor_lane_hint_key_round_trips() {
	let key = keys::actor::LaneHintKey::new(id(12));
	let encoded = key.serialize("cpu-heavy".to_owned()).unwrap();

	assert_eq!("cpu-heavy", key.deserialize(&encoded).unwrap());
}

#[test]
fn v2_actor_input_defaults_missing_lane_hint() {
	let mut value = serde_json::to_value(actor2::Input {
		actor_id: id(20),
		name: "game".to_owned(),
		pool_name: "pool".to_owned(),
		key: None,
		lane_hint: Some("io-heavy".to_owned()),
		namespace_id: id(21),
		input: None,
		from_v1: false,
	})
	.unwrap();
	value.as_object_mut().unwrap().remove("lane_hint");

	let decoded: actor2::Input = serde_json::from_value(value).unwrap();

	assert_eq!(None, decoded.lane_hint);
}

#[test]
fn v2_actor_state_resolves_missing_lane_hint_to_default_lane() {
	let mut value = serde_json::to_value(actor2::State::new(
		id(3),
		"game".to_owned(),
		"pool".to_owned(),
		Some("io-heavy".to_owned()),
		None,
		id(4),
		100,
	))
	.unwrap();
	value.as_object_mut().unwrap().remove("lane_hint");

	let decoded: actor2::State = serde_json::from_value(value).unwrap();

	assert_eq!(None, decoded.lane_hint);
	assert_eq!(WorkerLane::default(), decoded.worker_lane());
}

#[test]
fn v2_actor_state_preserves_explicit_lane_hint() {
	let state = actor2::State::new(
		id(5),
		"game".to_owned(),
		"pool".to_owned(),
		Some("io-heavy".to_owned()),
		None,
		id(6),
		100,
	);

	assert_eq!(Some("io-heavy"), state.lane_hint.as_deref());
	assert_eq!(WorkerLane::from("io-heavy"), state.worker_lane());
}
