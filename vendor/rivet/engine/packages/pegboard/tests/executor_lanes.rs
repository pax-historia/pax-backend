use std::{sync::Arc, time::Duration};

use futures_util::TryStreamExt;
use gas::prelude::*;
use pegboard::{
	executor::{
		ALLOC_INDEX_BUCKET_COUNT, RunnerAllocIndexCandidate, RunnerAllocIndexKey, WorkerLane,
		WorkerLaneCandidate, WorkerLaneEndpointCandidate, WorkerLaneEndpointPlacement,
		WorkerLanePending, WorkerLanePendingReason, WorkerLanePlacement, WorkerLanePlacementInput,
		actor_placement_key, alloc_bucket_for_placement_key, bucket_remaining_slots,
		bucket_slot_capacity, place_actor_in_worker_lane, place_actor_on_worker_endpoint,
	},
	keys,
};
use universaldb::{
	options::StreamingMode,
	utils::{FormalKey, IsolationLevel::*},
};

fn id(seed: u128) -> Id {
	Id::v1(uuid::Uuid::from_u128(seed), 1)
}

async fn test_db() -> Result<universaldb::Database> {
	let path = tempfile::Builder::new()
		.prefix("pegboard-executor-lanes-")
		.tempdir()?
		.keep();
	let driver = universaldb::driver::RocksDbDatabaseDriver::new(path).await?;

	Ok(universaldb::Database::new(Arc::new(driver)))
}

fn alloc_data(workflow_id: Id) -> rivet_data::converted::RunnerAllocIdxKeyData {
	rivet_data::converted::RunnerAllocIdxKeyData {
		workflow_id,
		remaining_slots: 9,
		total_slots: 10,
		protocol_version: 8,
	}
}

async fn collect_lane_drain_ids(
	db: &universaldb::Database,
	namespace_id: Id,
	name: &str,
	lane: WorkerLane,
) -> Result<Vec<Id>> {
	let name = name.to_owned();
	db.run(move |tx| {
		let lane = lane.clone();
		let name = name.clone();
		async move {
			pegboard::ops::runner::drain_lane::runner_workflow_ids_for_lane(
				&tx,
				namespace_id,
				&name,
				&lane,
			)
			.await
		}
	})
	.await
}

#[derive(Debug, Serialize, Deserialize)]
struct StopProbeInput {}

#[workflow(StopProbeWorkflow)]
async fn stop_probe_workflow(ctx: &mut WorkflowCtx, _input: &StopProbeInput) -> Result<bool> {
	let stop = ctx.listen::<pegboard::workflows::runner2::Stop>().await?;

	Ok(stop.reset_actor_rescheduling)
}

fn candidate(
	seed: u128,
	lane: impl Into<WorkerLane>,
	version: u32,
	remaining_slots: u32,
	total_slots: u32,
	last_ping_ts: i64,
) -> WorkerLaneCandidate {
	WorkerLaneCandidate {
		runner_id: id(seed),
		runner_workflow_id: id(seed + 1000),
		lane: lane.into(),
		version,
		remaining_slots,
		total_slots,
		last_ping_ts,
		protocol_version: Some(1),
	}
}

fn input<'a>(actor_key: &'a [u8], lane: &'a WorkerLane) -> WorkerLanePlacementInput<'a> {
	WorkerLanePlacementInput {
		actor_key,
		lane,
		now_ts: 1_000,
		runner_eligible_threshold: 100,
	}
}

#[test]
fn placement_key_uses_stable_actor_identity() {
	let namespace_id = id(90);
	let actor_id = id(91);

	assert_eq!(
		actor_placement_key(namespace_id, "game", Some("alpha"), actor_id),
		actor_placement_key(namespace_id, "game", Some("alpha"), id(92)),
	);
	assert_ne!(
		actor_placement_key(namespace_id, "game", None, actor_id),
		actor_placement_key(namespace_id, "game", None, id(92)),
	);
}

#[test]
fn runner_lane_keys_round_trip() {
	let lane_key = keys::runner::LaneKey::new(id(60));
	let encoded_lane = lane_key.serialize("cpu-heavy".to_owned()).unwrap();

	assert_eq!("cpu-heavy", lane_key.deserialize(&encoded_lane).unwrap());

	let alloc_key = keys::ns::RunnerLaneAllocIdxKey::new(
		id(61),
		"pool".to_owned(),
		"cpu-heavy".to_owned(),
		7,
		500,
		1_000,
		id(62),
	);
	let alloc_data = rivet_data::converted::RunnerAllocIdxKeyData {
		workflow_id: id(63),
		remaining_slots: 5,
		total_slots: 10,
		protocol_version: 8,
	};
	let encoded_alloc = alloc_key.serialize(alloc_data.clone()).unwrap();

	assert_eq!(alloc_data, alloc_key.deserialize(&encoded_alloc).unwrap());
}

#[test]
fn runner_lane_index_candidate_preserves_lane_on_rewrite() {
	let key = keys::ns::RunnerLaneAllocIdxKey::new(
		id(64),
		"pool".to_owned(),
		"cpu-heavy".to_owned(),
		7,
		900,
		1_000,
		id(65),
	);
	let data = rivet_data::converted::RunnerAllocIdxKeyData {
		workflow_id: id(66),
		remaining_slots: 9,
		total_slots: 10,
		protocol_version: 8,
	};
	let candidate = RunnerAllocIndexCandidate::from_lane(key, data);

	assert_eq!(
		WorkerLane::from("cpu-heavy"),
		candidate.worker_candidate().lane
	);

	let RunnerAllocIndexKey::Lane(replacement) = candidate.replacement_key(800) else {
		panic!("expected lane replacement key");
	};
	assert_eq!("cpu-heavy", replacement.lane);
	assert_eq!(800, replacement.remaining_millislots);
}

#[test]
fn runner_bucket_index_candidate_refreshes_liveness_timestamp() {
	let key = keys::ns::RunnerLaneAllocBucketIdxKey::new(
		id(67),
		"pool".to_owned(),
		"cpu-heavy".to_owned(),
		42,
		7,
		900,
		1_000,
		id(68),
	);
	let data = rivet_data::converted::RunnerAllocIdxKeyData {
		workflow_id: id(69),
		remaining_slots: 9,
		total_slots: 10,
		protocol_version: 8,
	};
	let candidate = RunnerAllocIndexCandidate::from_bucket_lane(key, data);
	let refreshed = candidate.with_last_ping_ts(2_000);

	assert!(refreshed.is_bucketed());
	assert_eq!(2_000, refreshed.last_ping_ts());
	assert_eq!(
		WorkerLane::from("cpu-heavy"),
		refreshed.worker_candidate().lane
	);
	assert_eq!(2_000, refreshed.worker_candidate().last_ping_ts);

	let RunnerAllocIndexKey::BucketLane(replacement) = refreshed.replacement_key(800) else {
		panic!("expected lane bucket replacement key");
	};
	assert_eq!("cpu-heavy", replacement.lane);
	assert_eq!(42, replacement.bucket);
	assert_eq!(2_000, replacement.last_ping_ts);
	assert_eq!(800, replacement.remaining_millislots);
}

#[test]
fn allocation_buckets_are_stable_and_cover_capacity() {
	let placement_key = actor_placement_key(id(70), "game", Some("alpha"), id(71));
	let bucket = alloc_bucket_for_placement_key(&placement_key);

	assert_eq!(bucket, alloc_bucket_for_placement_key(&placement_key));
	assert!(bucket < ALLOC_INDEX_BUCKET_COUNT);

	let total_capacity: u32 = (0..ALLOC_INDEX_BUCKET_COUNT)
		.map(|bucket| bucket_slot_capacity(10_000, bucket))
		.sum();
	let total_remaining: u32 = (0..ALLOC_INDEX_BUCKET_COUNT)
		.map(|bucket| bucket_remaining_slots(5_000, bucket))
		.sum();

	assert_eq!(10_000, total_capacity);
	assert_eq!(5_000, total_remaining);
}

#[tokio::test]
async fn pending_actor_lane_queue_scopes_by_lane() -> Result<()> {
	let db = test_db().await?;
	let namespace_id = id(64);
	let name = "pool";
	let default_actor_id = id(65);
	let cpu_actor_id = id(66);

	db.run(move |tx| async move {
		let tx = tx.with_subspace(keys::subspace());
		tx.write(
			&keys::ns::PendingActorByRunnerNameSelectorAndLaneKey::new(
				namespace_id,
				name.to_owned(),
				"default".to_owned(),
				100,
				default_actor_id,
			),
			1,
		)?;
		tx.write(
			&keys::ns::PendingActorByRunnerNameSelectorAndLaneKey::new(
				namespace_id,
				name.to_owned(),
				"cpu-heavy".to_owned(),
				90,
				cpu_actor_id,
			),
			2,
		)?;

		Ok(())
	})
	.await?;

	let cpu_pending = db
		.run(move |tx| async move {
			let tx = tx.with_subspace(keys::subspace());
			let pending_subspace = keys::subspace().subspace(
				&keys::ns::PendingActorByRunnerNameSelectorAndLaneKey::subspace(
					namespace_id,
					name.to_owned(),
					"cpu-heavy".to_owned(),
				),
			);
			let mut stream = tx.get_ranges_keyvalues(
				universaldb::RangeOption {
					mode: StreamingMode::WantAll,
					..(&pending_subspace).into()
				},
				Snapshot,
			);
			let mut actor_ids = Vec::new();

			while let Some(entry) = stream.try_next().await? {
				let (key, generation) =
					tx.read_entry::<keys::ns::PendingActorByRunnerNameSelectorAndLaneKey>(&entry)?;
				actor_ids.push((key.actor_id, generation));
			}

			Ok(actor_ids)
		})
		.await?;

	assert_eq!(vec![(cpu_actor_id, 2)], cpu_pending);

	Ok(())
}

#[tokio::test]
async fn lane_drain_reads_only_requested_capacity_index() -> Result<()> {
	let db = test_db().await?;
	let namespace_id = id(70);
	let name = "pool";
	let default_workflow_id = id(71);
	let cpu_workflow_id = id(72);
	let io_workflow_id = id(73);

	db.run(move |tx| async move {
		let tx = tx.with_subspace(keys::subspace());

		tx.write(
			&keys::ns::RunnerAllocIdxKey::new(namespace_id, name.to_owned(), 2, 900, 1_000, id(74)),
			alloc_data(default_workflow_id),
		)?;
		tx.write(
			&keys::ns::RunnerAllocIdxKey::new(namespace_id, name.to_owned(), 1, 800, 900, id(74)),
			alloc_data(default_workflow_id),
		)?;
		tx.write(
			&keys::ns::RunnerLaneAllocIdxKey::new(
				namespace_id,
				name.to_owned(),
				"cpu-heavy".to_owned(),
				2,
				900,
				1_000,
				id(75),
			),
			alloc_data(cpu_workflow_id),
		)?;
		tx.write(
			&keys::ns::RunnerLaneAllocIdxKey::new(
				namespace_id,
				name.to_owned(),
				"cpu-heavy".to_owned(),
				1,
				700,
				900,
				id(75),
			),
			alloc_data(cpu_workflow_id),
		)?;
		tx.write(
			&keys::ns::RunnerLaneAllocIdxKey::new(
				namespace_id,
				name.to_owned(),
				"io-heavy".to_owned(),
				2,
				900,
				1_000,
				id(76),
			),
			alloc_data(io_workflow_id),
		)?;

		Ok(())
	})
	.await?;

	let default_lane_ids =
		collect_lane_drain_ids(&db, namespace_id, name, WorkerLane::default()).await?;
	let cpu_lane_ids =
		collect_lane_drain_ids(&db, namespace_id, name, WorkerLane::from("cpu-heavy")).await?;
	let io_lane_ids =
		collect_lane_drain_ids(&db, namespace_id, name, WorkerLane::from("io-heavy")).await?;

	assert_eq!(vec![default_workflow_id], default_lane_ids);
	assert_eq!(vec![cpu_workflow_id], cpu_lane_ids);
	assert_eq!(vec![io_workflow_id], io_lane_ids);

	Ok(())
}

#[tokio::test]
async fn lane_drain_sends_runner_stop_signal() -> Result<()> {
	let mut registry = Registry::new();
	registry.register_workflow::<StopProbeWorkflow>()?;
	let test_ctx = TestCtx::new(registry).await?;
	let namespace_id = id(80);
	let name = "pool";
	let workflow_id = test_ctx.workflow(StopProbeInput {}).dispatch().await?;

	tokio::time::sleep(Duration::from_millis(100)).await;

	let db = test_ctx.pools().udb()?;
	db.run(move |tx| async move {
		let tx = tx.with_subspace(keys::subspace());
		tx.write(
			&keys::ns::RunnerLaneAllocIdxKey::new(
				namespace_id,
				name.to_owned(),
				"cpu-heavy".to_owned(),
				2,
				900,
				1_000,
				id(81),
			),
			alloc_data(workflow_id),
		)?;

		Ok(())
	})
	.await?;

	let output = test_ctx
		.op(pegboard::ops::runner::drain_lane::Input {
			namespace_id,
			name: name.to_owned(),
			lane: Some("cpu-heavy".to_owned()),
			reset_actor_rescheduling: true,
			send_runner_stop_signals: true,
		})
		.await?;

	assert_eq!(vec![workflow_id], output.runner_workflow_ids);

	let reset_actor_rescheduling = tokio::time::timeout(
		Duration::from_secs(5),
		test_ctx.workflow::<StopProbeInput>(workflow_id).output(),
	)
	.await??;

	assert!(reset_actor_rescheduling);

	Ok(())
}

fn selected_runner(placement: WorkerLanePlacement) -> Id {
	placement
		.selected()
		.expect("expected selected runner")
		.runner_id
}

fn endpoint(
	endpoint_key: &str,
	lane: impl Into<WorkerLane>,
	version: u32,
	last_ping_ts: i64,
) -> WorkerLaneEndpointCandidate {
	WorkerLaneEndpointCandidate {
		endpoint_key: endpoint_key.to_owned(),
		lane: lane.into(),
		version,
		last_ping_ts,
	}
}

fn selected_endpoint(placement: WorkerLaneEndpointPlacement) -> String {
	placement
		.selected()
		.expect("expected selected endpoint")
		.endpoint_key
		.clone()
}

#[test]
fn worker_lane_placement_is_deterministic_for_actor_key_and_lane() {
	let lane = WorkerLane::default();
	let candidates = vec![
		candidate(1, lane.clone(), 3, 6, 10, 990),
		candidate(2, lane.clone(), 3, 4, 10, 995),
		candidate(3, lane.clone(), 3, 9, 10, 980),
	];
	let expected = selected_runner(place_actor_in_worker_lane(
		input(b"actor:game:alpha", &lane),
		&candidates,
	));

	for _ in 0..8 {
		assert_eq!(
			expected,
			selected_runner(place_actor_in_worker_lane(
				input(b"actor:game:alpha", &lane),
				&candidates,
			))
		);
	}

	let mut reversed = candidates;
	reversed.reverse();
	assert_eq!(
		expected,
		selected_runner(place_actor_in_worker_lane(
			input(b"actor:game:alpha", &lane),
			&reversed,
		))
	);
}

#[test]
fn worker_endpoint_placement_is_deterministic_for_actor_key_and_lane() {
	let lane = WorkerLane::default();
	let candidates = vec![
		endpoint("envoy-a", lane.clone(), 7, 990),
		endpoint("envoy-b", lane.clone(), 7, 995),
		endpoint("envoy-c", lane.clone(), 7, 980),
	];
	let expected = selected_endpoint(place_actor_on_worker_endpoint(
		input(b"actor:game:eta", &lane),
		&candidates,
	));

	for _ in 0..8 {
		assert_eq!(
			expected,
			selected_endpoint(place_actor_on_worker_endpoint(
				input(b"actor:game:eta", &lane),
				&candidates,
			))
		);
	}

	let mut reversed = candidates;
	reversed.reverse();
	assert_eq!(
		expected,
		selected_endpoint(place_actor_on_worker_endpoint(
			input(b"actor:game:eta", &lane),
			&reversed,
		))
	);
}

#[test]
fn worker_endpoint_placement_respects_lane_partition() {
	let default_lane = WorkerLane::default();
	let io_lane = WorkerLane::from("io-heavy");
	let default_endpoint = endpoint("envoy-default", default_lane.clone(), 1, 990);
	let io_endpoint = endpoint("envoy-io", io_lane.clone(), 1, 990);
	let candidates = vec![default_endpoint.clone(), io_endpoint.clone()];

	assert_eq!(
		io_endpoint.endpoint_key,
		selected_endpoint(place_actor_on_worker_endpoint(
			input(b"actor:game:theta", &io_lane),
			&candidates,
		))
	);
	assert_eq!(
		default_endpoint.endpoint_key,
		selected_endpoint(place_actor_on_worker_endpoint(
			input(b"actor:game:theta", &default_lane),
			&candidates,
		))
	);
}

#[test]
fn lane_hint_is_a_hard_partition() {
	let default_lane = WorkerLane::default();
	let cpu_lane = WorkerLane::from("cpu-heavy");
	let default_candidate = candidate(10, default_lane.clone(), 1, 100, 100, 990);
	let cpu_candidate = candidate(11, cpu_lane.clone(), 1, 1, 100, 990);
	let candidates = vec![default_candidate.clone(), cpu_candidate.clone()];

	assert_eq!(
		cpu_candidate.runner_id,
		selected_runner(place_actor_in_worker_lane(
			input(b"actor:game:beta", &cpu_lane),
			&candidates,
		))
	);
	assert_eq!(
		default_candidate.runner_id,
		selected_runner(place_actor_in_worker_lane(
			input(b"actor:game:beta", &default_lane),
			&candidates,
		))
	);
}

#[test]
fn worker_endpoint_newest_version_fences_older_capacity() {
	let lane = WorkerLane::default();
	let candidates = vec![
		endpoint("envoy-new-stale", lane.clone(), 4, 800),
		endpoint("envoy-old-fresh", lane.clone(), 3, 990),
	];

	assert_eq!(
		WorkerLaneEndpointPlacement::Pending(WorkerLanePending {
			lane: lane.clone(),
			reason: WorkerLanePendingReason::StaleRunners,
		}),
		place_actor_on_worker_endpoint(input(b"actor:game:iota", &lane), &candidates)
	);
}

#[test]
fn zero_capacity_candidates_are_excluded() {
	let lane = WorkerLane::default();
	let empty = candidate(20, lane.clone(), 2, 0, 10, 990);
	let available = candidate(21, lane.clone(), 2, 1, 10, 990);
	let candidates = vec![empty, available.clone()];

	let placement = place_actor_in_worker_lane(input(b"actor:game:gamma", &lane), &candidates);
	let assignment = placement.selected().expect("expected selected runner");

	assert_eq!(available.runner_id, assignment.runner_id);
	assert_eq!(1, assignment.remaining_slots_before);
	assert_eq!(0, assignment.remaining_slots_after);
	assert_eq!(0, assignment.remaining_millislots_after);
}

#[test]
fn newest_version_fences_older_capacity() {
	let lane = WorkerLane::default();
	let candidates = vec![
		candidate(30, lane.clone(), 4, 0, 10, 990),
		candidate(31, lane.clone(), 3, 10, 10, 990),
	];

	assert_eq!(
		WorkerLanePlacement::Pending(WorkerLanePending {
			lane: lane.clone(),
			reason: WorkerLanePendingReason::NoCapacity,
		}),
		place_actor_in_worker_lane(input(b"actor:game:delta", &lane), &candidates)
	);
}

#[test]
fn stale_newest_version_does_not_fall_back_to_older_runner() {
	let lane = WorkerLane::default();
	let candidates = vec![
		candidate(40, lane.clone(), 4, 10, 10, 800),
		candidate(41, lane.clone(), 3, 10, 10, 990),
	];

	assert_eq!(
		WorkerLanePlacement::Pending(WorkerLanePending {
			lane: lane.clone(),
			reason: WorkerLanePendingReason::StaleRunners,
		}),
		place_actor_in_worker_lane(input(b"actor:game:epsilon", &lane), &candidates)
	);
}

#[test]
fn missing_lane_returns_no_candidates() {
	let requested_lane = WorkerLane::from("io-heavy");
	let candidates = vec![candidate(50, WorkerLane::default(), 1, 10, 10, 990)];

	assert_eq!(
		WorkerLanePlacement::Pending(WorkerLanePending {
			lane: requested_lane.clone(),
			reason: WorkerLanePendingReason::NoCandidates,
		}),
		place_actor_in_worker_lane(input(b"actor:game:zeta", &requested_lane), &candidates)
	);
}
