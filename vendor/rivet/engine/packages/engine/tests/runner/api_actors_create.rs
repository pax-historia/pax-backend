use super::super::common;

use std::{
	collections::HashSet,
	time::{Duration, Instant},
};

use futures_util::future::join_all;

// MARK: Basic
#[test]
fn create_actor_valid_namespace() {
	common::run(common::TestOpts::new(1), |ctx| async move {
		let (namespace, _, runner) =
			common::setup_test_namespace_with_runner(ctx.leader_dc()).await;

		let res = common::api::public::actors_create(
			ctx.leader_dc().guard_port(),
			common::api_types::actors::create::CreateQuery {
				namespace: namespace.clone(),
			},
			common::api_types::actors::create::CreateRequest {
				datacenter: None,
				name: "test-actor".to_string(),
				key: None,
				input: None,
				runner_name_selector: runner.name().to_string(),
				lane_hint: None,
				crash_policy: rivet_types::actors::CrashPolicy::Destroy,
			},
		)
		.await
		.expect("failed to create actor");
		let actor_id = res.actor.actor_id.to_string();

		common::assert_actor_exists(ctx.leader_dc().guard_port(), &actor_id, &namespace).await;

		// TODO: Hook into engine instead of sleep
		tokio::time::sleep(std::time::Duration::from_secs(1)).await;

		assert!(
			runner.has_actor(&actor_id).await,
			"runner should have the actor"
		);
	});
}

#[test]
fn create_actor_with_lane_hint_uses_matching_runner_lane() {
	common::run(common::TestOpts::new(1), |ctx| async move {
		let (namespace, _) = common::setup_test_namespace(ctx.leader_dc()).await;
		let default_runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
			builder
				.with_runner_key("actor-default-lane-key")
				.with_runner_name(common::TEST_RUNNER_NAME)
		})
		.await;
		let cpu_runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
			builder
				.with_runner_key("actor-cpu-heavy-lane-key")
				.with_runner_name(common::TEST_RUNNER_NAME)
				.with_lane("cpu-heavy")
		})
		.await;

		let response = common::api::public::actors_create(
			ctx.leader_dc().guard_port(),
			common::api_types::actors::create::CreateQuery {
				namespace: namespace.clone(),
			},
			common::api_types::actors::create::CreateRequest {
				datacenter: None,
				name: "test-actor".to_string(),
				key: Some("cpu-heavy-placement".to_string()),
				input: None,
				runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
				lane_hint: Some("cpu-heavy".to_string()),
				crash_policy: rivet_types::actors::CrashPolicy::Destroy,
			},
		)
		.await
		.expect("failed to create cpu-heavy actor");
		let actor_id = response.actor.actor_id.to_string();

		common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
			let cpu_runner = &cpu_runner;
			let actor_id = actor_id.clone();
			async move { cpu_runner.has_actor(&actor_id).await.then_some(()) }
		})
		.await
		.expect("cpu-heavy actor should start on cpu-heavy runner");

		assert!(
			!default_runner.has_actor(&actor_id).await,
			"default runner should not receive actor with cpu-heavy lane hint"
		);
	});
}

#[test]
fn keyed_lane_actor_recreate_uses_same_runner() {
	common::run(
		common::TestOpts::new(1).with_timeout(45),
		|ctx| async move {
			let (namespace, namespace_id) = common::setup_test_namespace(ctx.leader_dc()).await;
			let guard_port = ctx.leader_dc().guard_port();
			let cpu_runner_a = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
				builder
					.with_runner_key("deterministic-cpu-heavy-a")
					.with_runner_name(common::TEST_RUNNER_NAME)
					.with_lane("cpu-heavy")
					.with_total_slots(1)
			})
			.await;
			let cpu_runner_b = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
				builder
					.with_runner_key("deterministic-cpu-heavy-b")
					.with_runner_name(common::TEST_RUNNER_NAME)
					.with_lane("cpu-heavy")
					.with_total_slots(1)
			})
			.await;
			let cpu_runner_a_id = cpu_runner_a.wait_ready().await;
			let cpu_runner_b_id = cpu_runner_b.wait_ready().await;

			let first_actor = common::api::public::actors_create(
				guard_port,
				common::api_types::actors::create::CreateQuery {
					namespace: namespace.clone(),
				},
				common::api_types::actors::create::CreateRequest {
					datacenter: None,
					name: "test-actor".to_string(),
					key: Some("deterministic-cpu-heavy-placement".to_string()),
					input: None,
					runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
					lane_hint: Some("cpu-heavy".to_string()),
					crash_policy: rivet_types::actors::CrashPolicy::Destroy,
				},
			)
			.await
			.expect("failed to create keyed cpu-heavy actor");
			let first_actor_id = first_actor.actor.actor_id.to_string();

			let first_runner_idx =
				common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
					let first_actor_id = first_actor_id.clone();
					let cpu_runner_a = &cpu_runner_a;
					let cpu_runner_b = &cpu_runner_b;

					async move {
						match (
							cpu_runner_a.has_actor(&first_actor_id).await,
							cpu_runner_b.has_actor(&first_actor_id).await,
						) {
							(true, false) => Some(0),
							(false, true) => Some(1),
							_ => None,
						}
					}
				})
				.await
				.expect("keyed cpu-heavy actor should start on exactly one cpu-heavy runner");
			let (selected_runner, selected_runner_id, other_runner) = if first_runner_idx == 0 {
				(&cpu_runner_a, cpu_runner_a_id, &cpu_runner_b)
			} else {
				(&cpu_runner_b, cpu_runner_b_id, &cpu_runner_a)
			};

			common::api::public::actors_delete(
				guard_port,
				common::api_types::actors::delete::DeletePath {
					actor_id: first_actor.actor.actor_id,
				},
				common::api_types::actors::delete::DeleteQuery {
					namespace: namespace.clone(),
				},
			)
			.await
			.expect("failed to delete keyed cpu-heavy actor");
			common::assert_actor_is_destroyed(guard_port, &first_actor_id, &namespace).await;

			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let selected_runner = selected_runner;
				let first_actor_id = first_actor_id.clone();

				async move { (!selected_runner.has_actor(&first_actor_id).await).then_some(()) }
			})
			.await
			.expect("deleted keyed actor should leave the selected runner");

			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let selected_runner_id = selected_runner_id.clone();
				let dc = ctx.leader_dc();

				async move {
					let runners = dc
						.workflow_ctx
						.op(pegboard::ops::runner::list_for_ns::Input {
							namespace_id,
							name: Some(common::TEST_RUNNER_NAME.to_string()),
							include_stopped: false,
							created_before: None,
							limit: 100,
						})
						.await
						.ok()?;

					runners
						.runners
						.iter()
						.any(|runner| {
							runner.runner_id.to_string() == selected_runner_id
								&& runner.remaining_slots == runner.total_slots
						})
						.then_some(())
				}
			})
			.await
			.expect("selected runner capacity should be restored after delete");

			let second_actor = common::api::public::actors_create(
				guard_port,
				common::api_types::actors::create::CreateQuery {
					namespace: namespace.clone(),
				},
				common::api_types::actors::create::CreateRequest {
					datacenter: None,
					name: "test-actor".to_string(),
					key: Some("deterministic-cpu-heavy-placement".to_string()),
					input: None,
					runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
					lane_hint: Some("cpu-heavy".to_string()),
					crash_policy: rivet_types::actors::CrashPolicy::Destroy,
				},
			)
			.await
			.expect("failed to recreate keyed cpu-heavy actor");
			let second_actor_id = second_actor.actor.actor_id.to_string();

			assert_ne!(
				first_actor_id, second_actor_id,
				"recreating a destroyed keyed actor should allocate a new actor id"
			);
			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let selected_runner = selected_runner;
				let second_actor_id = second_actor_id.clone();

				async move {
					selected_runner
						.has_actor(&second_actor_id)
						.await
						.then_some(())
				}
			})
			.await
			.expect("recreated keyed cpu-heavy actor should return to the same runner");
			assert!(
				!other_runner.has_actor(&second_actor_id).await,
				"recreated keyed cpu-heavy actor should not drift to the other runner"
			);
		},
	);
}

#[test]
fn lane_capacity_partition_keeps_default_overflow_pending() {
	common::run(
		common::TestOpts::new(1).with_timeout(30),
		|ctx| async move {
			let (namespace, _) = common::setup_test_namespace(ctx.leader_dc()).await;
			let guard_port = ctx.leader_dc().guard_port();
			let default_runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
				builder
					.with_runner_key("capacity-default-lane-key")
					.with_runner_name(common::TEST_RUNNER_NAME)
					.with_total_slots(1)
			})
			.await;
			let cpu_runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
				builder
					.with_runner_key("capacity-cpu-heavy-lane-key")
					.with_runner_name(common::TEST_RUNNER_NAME)
					.with_lane("cpu-heavy")
					.with_total_slots(1)
			})
			.await;

			let default_actor = common::api::public::actors_create(
				guard_port,
				common::api_types::actors::create::CreateQuery {
					namespace: namespace.clone(),
				},
				common::api_types::actors::create::CreateRequest {
					datacenter: None,
					name: "test-actor".to_string(),
					key: Some("default-capacity-fill".to_string()),
					input: None,
					runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
					lane_hint: None,
					crash_policy: rivet_types::actors::CrashPolicy::Destroy,
				},
			)
			.await
			.expect("failed to create default actor");
			let default_actor_id = default_actor.actor.actor_id.to_string();

			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let default_runner = &default_runner;
				let default_actor_id = default_actor_id.clone();
				async move {
					default_runner
						.has_actor(&default_actor_id)
						.await
						.then_some(())
				}
			})
			.await
			.expect("default actor should fill the default runner");

			let overflow_actor = common::api::public::actors_create(
				guard_port,
				common::api_types::actors::create::CreateQuery {
					namespace: namespace.clone(),
				},
				common::api_types::actors::create::CreateRequest {
					datacenter: None,
					name: "test-actor".to_string(),
					key: Some("default-capacity-overflow".to_string()),
					input: None,
					runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
					lane_hint: None,
					crash_policy: rivet_types::actors::CrashPolicy::Destroy,
				},
			)
			.await
			.expect("failed to create default overflow actor");
			let overflow_actor_id = overflow_actor.actor.actor_id.to_string();

			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let namespace = namespace.clone();
				let overflow_actor_id = overflow_actor_id.clone();
				async move {
					let actor = common::try_get_actor(guard_port, &overflow_actor_id, &namespace)
						.await
						.ok()
						.flatten()?;

					actor.pending_allocation_ts.is_some().then_some(())
				}
			})
			.await
			.expect("default overflow actor should remain pending");
			assert!(
				!cpu_runner.has_actor(&overflow_actor_id).await,
				"default overflow actor should not consume cpu-heavy lane capacity"
			);

			let cpu_actor = common::api::public::actors_create(
				guard_port,
				common::api_types::actors::create::CreateQuery {
					namespace: namespace.clone(),
				},
				common::api_types::actors::create::CreateRequest {
					datacenter: None,
					name: "test-actor".to_string(),
					key: Some("cpu-capacity-available".to_string()),
					input: None,
					runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
					lane_hint: Some("cpu-heavy".to_string()),
					crash_policy: rivet_types::actors::CrashPolicy::Destroy,
				},
			)
			.await
			.expect("failed to create cpu-heavy actor");
			let cpu_actor_id = cpu_actor.actor.actor_id.to_string();

			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let cpu_runner = &cpu_runner;
				let cpu_actor_id = cpu_actor_id.clone();
				async move { cpu_runner.has_actor(&cpu_actor_id).await.then_some(()) }
			})
			.await
			.expect("cpu-heavy actor should start despite default lane overflow");

			assert!(
				!default_runner.has_actor(&cpu_actor_id).await,
				"cpu-heavy actor should not consume default lane capacity"
			);
		},
	);
}

#[test]
fn lane_capacity_partition_keeps_cpu_overflow_pending() {
	common::run(
		common::TestOpts::new(1).with_timeout(30),
		|ctx| async move {
			let (namespace, _) = common::setup_test_namespace(ctx.leader_dc()).await;
			let guard_port = ctx.leader_dc().guard_port();
			let default_runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
				builder
					.with_runner_key("cpu-overflow-default-lane-key")
					.with_runner_name(common::TEST_RUNNER_NAME)
					.with_total_slots(1)
			})
			.await;
			let cpu_runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
				builder
					.with_runner_key("cpu-overflow-cpu-heavy-lane-key")
					.with_runner_name(common::TEST_RUNNER_NAME)
					.with_lane("cpu-heavy")
					.with_total_slots(1)
			})
			.await;

			let cpu_fill_actor = common::api::public::actors_create(
				guard_port,
				common::api_types::actors::create::CreateQuery {
					namespace: namespace.clone(),
				},
				common::api_types::actors::create::CreateRequest {
					datacenter: None,
					name: "test-actor".to_string(),
					key: Some("cpu-overflow-fill".to_string()),
					input: None,
					runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
					lane_hint: Some("cpu-heavy".to_string()),
					crash_policy: rivet_types::actors::CrashPolicy::Destroy,
				},
			)
			.await
			.expect("failed to create cpu-heavy fill actor");
			let cpu_fill_actor_id = cpu_fill_actor.actor.actor_id.to_string();

			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let cpu_runner = &cpu_runner;
				let cpu_fill_actor_id = cpu_fill_actor_id.clone();
				async move { cpu_runner.has_actor(&cpu_fill_actor_id).await.then_some(()) }
			})
			.await
			.expect("cpu-heavy actor should fill the cpu-heavy runner");

			let cpu_overflow_actor = common::api::public::actors_create(
				guard_port,
				common::api_types::actors::create::CreateQuery {
					namespace: namespace.clone(),
				},
				common::api_types::actors::create::CreateRequest {
					datacenter: None,
					name: "test-actor".to_string(),
					key: Some("cpu-overflow-pending".to_string()),
					input: None,
					runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
					lane_hint: Some("cpu-heavy".to_string()),
					crash_policy: rivet_types::actors::CrashPolicy::Destroy,
				},
			)
			.await
			.expect("failed to create cpu-heavy overflow actor");
			let cpu_overflow_actor_id = cpu_overflow_actor.actor.actor_id.to_string();

			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let namespace = namespace.clone();
				let cpu_overflow_actor_id = cpu_overflow_actor_id.clone();
				async move {
					let actor =
						common::try_get_actor(guard_port, &cpu_overflow_actor_id, &namespace)
							.await
							.ok()
							.flatten()?;

					actor.pending_allocation_ts.is_some().then_some(())
				}
			})
			.await
			.expect("cpu-heavy overflow actor should remain pending");
			assert!(
				!default_runner.has_actor(&cpu_overflow_actor_id).await,
				"cpu-heavy overflow actor should not consume default lane capacity"
			);

			let default_actor = common::api::public::actors_create(
				guard_port,
				common::api_types::actors::create::CreateQuery {
					namespace: namespace.clone(),
				},
				common::api_types::actors::create::CreateRequest {
					datacenter: None,
					name: "test-actor".to_string(),
					key: Some("default-capacity-available".to_string()),
					input: None,
					runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
					lane_hint: None,
					crash_policy: rivet_types::actors::CrashPolicy::Destroy,
				},
			)
			.await
			.expect("failed to create default actor");
			let default_actor_id = default_actor.actor.actor_id.to_string();

			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let default_runner = &default_runner;
				let default_actor_id = default_actor_id.clone();
				async move {
					default_runner
						.has_actor(&default_actor_id)
						.await
						.then_some(())
				}
			})
			.await
			.expect("default actor should start despite cpu-heavy lane overflow");

			assert!(
				!cpu_runner.has_actor(&default_actor_id).await,
				"default actor should not consume cpu-heavy lane capacity"
			);
		},
	);
}

#[test]
fn lane_cohort_uses_multiple_runner_capacity() {
	common::run(
		common::TestOpts::new(1).with_timeout(45),
		|ctx| async move {
			let (namespace, _) = common::setup_test_namespace(ctx.leader_dc()).await;
			let guard_port = ctx.leader_dc().guard_port();
			let mut runners = Vec::new();

			for idx in 0..4 {
				let runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
					builder
						.with_runner_key(&format!("cohort-cpu-heavy-lane-key-{idx}"))
						.with_runner_name(common::TEST_RUNNER_NAME)
						.with_lane("cpu-heavy")
						.with_total_slots(2)
				})
				.await;

				runners.push(runner);
			}

			let actor_ids = join_all((0..8).map(|idx| {
				let namespace = namespace.clone();

				async move {
					common::api::public::actors_create(
						guard_port,
						common::api_types::actors::create::CreateQuery { namespace },
						common::api_types::actors::create::CreateRequest {
							datacenter: None,
							name: "test-actor".to_string(),
							key: Some(format!("lane-cohort-{idx}")),
							input: None,
							runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
							lane_hint: Some("cpu-heavy".to_string()),
							crash_policy: rivet_types::actors::CrashPolicy::Destroy,
						},
					)
					.await
					.expect("failed to create cpu-heavy cohort actor")
					.actor
					.actor_id
					.to_string()
				}
			}))
			.await;
			let expected_actor_ids: HashSet<_> = actor_ids.iter().cloned().collect();

			let counts =
				common::wait_with_poll(Duration::from_secs(15), Duration::from_millis(100), || {
					let expected_actor_ids = expected_actor_ids.clone();
					let runners = &runners;

					async move {
						let mut assigned_actor_ids = HashSet::new();
						let mut counts = Vec::new();

						for runner in runners {
							let runner_actor_ids = runner.get_actor_ids().await;
							counts.push(runner_actor_ids.len());
							assigned_actor_ids.extend(runner_actor_ids);
						}

						(assigned_actor_ids == expected_actor_ids).then_some(counts)
					}
				})
				.await
				.expect("all cpu-heavy cohort actors should start on cpu-heavy runners");

			assert_eq!(8, counts.iter().sum::<usize>());
			assert!(
				counts.iter().all(|count| *count <= 2),
				"runner lane capacity should cap each cpu-heavy runner at two actors: {counts:?}"
			);

			let mut sorted_counts = counts.clone();
			sorted_counts.sort_unstable();
			assert_eq!(
				vec![2, 2, 2, 2],
				sorted_counts,
				"cohort should use all available cpu-heavy runner capacity"
			);
		},
	);
}

#[test]
fn lane_cohort_setup_wall_clock_tracks_parallel_capacity() {
	common::run(
		common::TestOpts::new(1).with_timeout(90),
		|ctx| async move {
			const RUNNER_COUNT: usize = 8;
			const SLOTS_PER_RUNNER: u32 = 2;
			const ACTOR_COUNT: usize = RUNNER_COUNT * SLOTS_PER_RUNNER as usize;

			let (namespace, _) = common::setup_test_namespace(ctx.leader_dc()).await;
			let guard_port = ctx.leader_dc().guard_port();
			let startup_delay = Duration::from_millis(750);
			let runner_name = "lane-wall-clock-runner";
			let baseline_runner_name = "lane-wall-clock-baseline-runner";

			let baseline_runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
				builder
					.with_runner_key("wall-clock-baseline-cpu-heavy-lane-key")
					.with_runner_name(baseline_runner_name)
					.with_lane("cpu-heavy")
					.with_total_slots(1)
					.with_actor_behavior("slow-start-actor", move |_| {
						Box::new(common::test_runner::DelayedStartActor::new(startup_delay))
					})
			})
			.await;

			let baseline_start = Instant::now();
			let baseline_actor = common::api::public::actors_create(
				guard_port,
				common::api_types::actors::create::CreateQuery {
					namespace: namespace.clone(),
				},
				common::api_types::actors::create::CreateRequest {
					datacenter: None,
					name: "slow-start-actor".to_string(),
					key: Some("lane-wall-clock-baseline".to_string()),
					input: None,
					runner_name_selector: baseline_runner_name.to_string(),
					lane_hint: Some("cpu-heavy".to_string()),
					crash_policy: rivet_types::actors::CrashPolicy::Destroy,
				},
			)
			.await
			.expect("failed to create baseline cpu-heavy actor");
			let baseline_actor_id = baseline_actor.actor.actor_id.to_string();

			common::wait_with_poll(Duration::from_secs(15), Duration::from_millis(100), || {
				let namespace = namespace.clone();
				let baseline_actor_id = baseline_actor_id.clone();

				async move {
					let actor = common::try_get_actor(guard_port, &baseline_actor_id, &namespace)
						.await
						.ok()
						.flatten()?;

					actor.connectable_ts.is_some().then_some(())
				}
			})
			.await
			.expect("baseline actor should become connectable");
			let single_actor_elapsed = baseline_start.elapsed();
			assert!(
				baseline_runner.has_actor(&baseline_actor_id).await,
				"baseline actor should land on the baseline cpu-heavy runner"
			);

			let mut runners = Vec::new();
			for idx in 0..RUNNER_COUNT {
				let runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
					builder
						.with_runner_key(&format!("wall-clock-cpu-heavy-lane-key-{idx}"))
						.with_runner_name(runner_name)
						.with_lane("cpu-heavy")
						.with_total_slots(SLOTS_PER_RUNNER)
						.with_actor_behavior("slow-start-actor", move |_| {
							Box::new(common::test_runner::DelayedStartActor::new(startup_delay))
						})
				})
				.await;

				runners.push(runner);
			}

			let setup_start = Instant::now();
			let actor_ids = join_all((0..ACTOR_COUNT).map(|idx| {
				let namespace = namespace.clone();

				async move {
					common::api::public::actors_create(
						guard_port,
						common::api_types::actors::create::CreateQuery { namespace },
						common::api_types::actors::create::CreateRequest {
							datacenter: None,
							name: "slow-start-actor".to_string(),
							key: Some(format!("lane-wall-clock-cohort-{idx}")),
							input: None,
							runner_name_selector: runner_name.to_string(),
							lane_hint: Some("cpu-heavy".to_string()),
							crash_policy: rivet_types::actors::CrashPolicy::Destroy,
						},
					)
					.await
					.expect("failed to create cpu-heavy wall-clock cohort actor")
					.actor
					.actor_id
					.to_string()
				}
			}))
			.await;
			let expected_actor_ids: HashSet<_> = actor_ids.iter().cloned().collect();

			common::wait_with_poll(Duration::from_secs(30), Duration::from_millis(100), || {
				let namespace = namespace.clone();
				let actor_ids = actor_ids.clone();

				async move {
					for actor_id in &actor_ids {
						let actor = common::try_get_actor(guard_port, actor_id, &namespace)
							.await
							.ok()
							.flatten()?;

						if actor.connectable_ts.is_none() {
							return None;
						}
					}

					Some(())
				}
			})
			.await
			.expect("all cpu-heavy cohort actors should become connectable");
			let cohort_elapsed = setup_start.elapsed();

			let counts =
				common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
					let expected_actor_ids = expected_actor_ids.clone();
					let runners = &runners;

					async move {
						let mut assigned_actor_ids = HashSet::new();
						let mut counts = Vec::new();

						for runner in runners {
							let runner_actor_ids = runner.get_actor_ids().await;
							counts.push(runner_actor_ids.len());
							assigned_actor_ids.extend(runner_actor_ids);
						}

						(assigned_actor_ids == expected_actor_ids).then_some(counts)
					}
				})
				.await
				.expect("connectable cohort actors should be assigned to cpu-heavy runners");

			assert_eq!(ACTOR_COUNT, counts.iter().sum::<usize>());
			assert!(
				counts
					.iter()
					.all(|count| *count <= SLOTS_PER_RUNNER as usize),
				"runner lane capacity should cap each cpu-heavy runner at {SLOTS_PER_RUNNER} actors: {counts:?}"
			);
			assert!(
				counts.iter().all(|count| *count > 0),
				"cohort setup should consume every cpu-heavy runner lane: {counts:?}"
			);

			// Padded for CI variance, but still below a half-serial 16-actor delayed start.
			let max_parallel_elapsed = single_actor_elapsed * 8 + Duration::from_secs(3);
			tracing::info!(
				single_actor_ms = single_actor_elapsed.as_millis(),
				cohort_ms = cohort_elapsed.as_millis(),
				max_parallel_ms = max_parallel_elapsed.as_millis(),
				?counts,
				"executor lane cohort setup wall-clock"
			);
			assert!(
				cohort_elapsed < max_parallel_elapsed,
				"cpu-heavy cohort setup should scale with lane capacity; single={single_actor_elapsed:?}, cohort={cohort_elapsed:?}, max={max_parallel_elapsed:?}, counts={counts:?}"
			);
		},
	);
}

#[test]
fn create_actor_with_key() {
	common::run(common::TestOpts::new(1), |ctx| async move {
		let (namespace, _, _runner) =
			common::setup_test_namespace_with_runner(ctx.leader_dc()).await;

		let key = common::generate_unique_key();
		let res = common::api::public::actors_create(
			ctx.leader_dc().guard_port(),
			common::api_types::actors::create::CreateQuery {
				namespace: namespace.clone(),
			},
			common::api_types::actors::create::CreateRequest {
				datacenter: None,
				name: "test-actor".to_string(),
				key: Some(key.clone()),
				input: None,
				runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
				lane_hint: None,
				crash_policy: rivet_types::actors::CrashPolicy::Destroy,
			},
		)
		.await
		.expect("failed to create actor");
		let actor_id = res.actor.actor_id.to_string();

		assert!(!actor_id.is_empty(), "actor ID should not be empty");

		// Verify actor exists
		let actor =
			common::assert_actor_exists(ctx.leader_dc().guard_port(), &actor_id, &namespace).await;
		assert_eq!(actor.key, Some(key));
	});
}

#[test]
fn create_actor_with_input() {
	common::run(common::TestOpts::new(1), |ctx| async move {
		let (namespace, _, _runner) =
			common::setup_test_namespace_with_runner(ctx.leader_dc()).await;

		let input_data = common::generate_test_input_data();
		let res = common::api::public::actors_create(
			ctx.leader_dc().guard_port(),
			common::api_types::actors::create::CreateQuery {
				namespace: namespace.clone(),
			},
			common::api_types::actors::create::CreateRequest {
				datacenter: None,
				name: "test-actor".to_string(),
				key: None,
				input: Some(input_data.clone()),
				runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
				lane_hint: None,
				crash_policy: rivet_types::actors::CrashPolicy::Destroy,
			},
		)
		.await
		.expect("failed to create actor");
		let actor_id = res.actor.actor_id.to_string();

		assert!(!actor_id.is_empty(), "actor ID should not be empty");
	});
}

#[test]
// Broken legacy Pegboard Runner test: full engine sweep timed out in
// `create_durable_actor`.
#[ignore = "broken legacy Pegboard Runner test: times out in full engine sweep"]
fn create_durable_actor() {
	common::run(common::TestOpts::new(1), |ctx| async move {
		let (namespace, _, _runner) =
			common::setup_test_namespace_with_runner(ctx.leader_dc()).await;

		let res = common::api::public::actors_create(
			ctx.leader_dc().guard_port(),
			common::api_types::actors::create::CreateQuery {
				namespace: namespace.clone(),
			},
			common::api_types::actors::create::CreateRequest {
				datacenter: None,
				name: "test-actor".to_string(),
				key: None,
				input: None,
				runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
				lane_hint: None,
				crash_policy: rivet_types::actors::CrashPolicy::Restart,
			},
		)
		.await
		.expect("failed to create actor");
		let actor_id = res.actor.actor_id.to_string();

		assert!(!actor_id.is_empty(), "actor ID should not be empty");

		// Verify actor is durable
		let actor =
			common::assert_actor_exists(ctx.leader_dc().guard_port(), &actor_id, &namespace).await;
		assert_eq!(
			actor.crash_policy,
			rivet_types::actors::CrashPolicy::Restart
		);
	});
}

#[test]
// Broken legacy Pegboard Runner test: full engine sweep timed out in
// `create_actor_specific_datacenter`.
#[ignore = "broken legacy Pegboard Runner test: times out in full engine sweep"]
fn create_actor_specific_datacenter() {
	common::run(common::TestOpts::new(2), |ctx| async move {
		let (namespace, _, _runner) =
			common::setup_test_namespace_with_runner(ctx.leader_dc()).await;

		let res = common::api::public::actors_create(
			ctx.leader_dc().guard_port(),
			common::api_types::actors::create::CreateQuery {
				namespace: namespace.clone(),
			},
			common::api_types::actors::create::CreateRequest {
				datacenter: Some("dc-2".to_string()),
				name: "test-actor".to_string(),
				key: None,
				input: None,
				runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
				lane_hint: None,
				crash_policy: rivet_types::actors::CrashPolicy::Destroy,
			},
		)
		.await
		.expect("failed to create actor");
		let actor_id = res.actor.actor_id.to_string();

		assert!(!actor_id.is_empty(), "actor ID should not be empty");

		let actor =
			common::assert_actor_exists(ctx.leader_dc().guard_port(), &actor_id, &namespace).await;
		common::assert_actor_in_dc(&actor.actor_id.to_string(), 2).await;
	});
}

// MARK: Error cases
#[test]
fn create_actor_non_existent_namespace() {
	common::run(common::TestOpts::new(1), |ctx| async move {
		let res = common::api::public::actors_create(
			ctx.leader_dc().guard_port(),
			common::api_types::actors::create::CreateQuery {
				namespace: "non-existent-namespace".to_string(),
			},
			common::api_types::actors::create::CreateRequest {
				datacenter: None,
				name: "test-actor".to_string(),
				key: None,
				input: None,
				runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
				lane_hint: None,
				crash_policy: rivet_types::actors::CrashPolicy::Destroy,
			},
		)
		.await;

		assert!(
			res.is_err(),
			"should fail to create actor with non-existent namespace"
		);
	});
}

#[test]
fn create_actor_invalid_datacenter() {
	common::run(common::TestOpts::new(1), |ctx| async move {
		let (namespace, _, _runner) =
			common::setup_test_namespace_with_runner(ctx.leader_dc()).await;

		let res = common::api::public::actors_create(
			ctx.leader_dc().guard_port(),
			common::api_types::actors::create::CreateQuery {
				namespace: namespace.clone(),
			},
			common::api_types::actors::create::CreateRequest {
				datacenter: Some("invalid-dc".to_string()),
				name: "test-actor".to_string(),
				key: None,
				input: None,
				runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
				lane_hint: None,
				crash_policy: rivet_types::actors::CrashPolicy::Destroy,
			},
		)
		.await;

		assert!(
			res.is_err(),
			"should fail to create actor with invalid datacenter"
		);
	});
}

// MARK: Cross-datacenter tests
#[test]
// Broken legacy Pegboard Runner test: full engine sweep timed out in
// `create_actor_remote_datacenter_verify`.
#[ignore = "broken legacy Pegboard Runner test: times out in full engine sweep"]
fn create_actor_remote_datacenter_verify() {
	common::run(common::TestOpts::new(2), |ctx| async move {
		let (namespace, _, _runner) =
			common::setup_test_namespace_with_runner(ctx.leader_dc()).await;

		let res = common::api::public::actors_create(
			ctx.leader_dc().guard_port(),
			common::api_types::actors::create::CreateQuery {
				namespace: namespace.clone(),
			},
			common::api_types::actors::create::CreateRequest {
				datacenter: Some("dc-2".to_string()),
				name: "test-actor".to_string(),
				key: None,
				input: None,
				runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
				lane_hint: None,
				crash_policy: rivet_types::actors::CrashPolicy::Destroy,
			},
		)
		.await
		.expect("failed to create actor");

		let actor_id = res.actor.actor_id.to_string();

		let actor =
			common::assert_actor_exists(ctx.get_dc(2).guard_port(), &actor_id, &namespace).await;
		common::assert_actor_in_dc(&actor.actor_id.to_string(), 2).await;
	});
}

// MARK: Input validation tests
// Note: Input at exactly 4 MiB is tested, but the HTTP layer has a body limit
// that may be lower than the validation limit. The validation is still tested
// by the exceeds test below.

#[test]
fn create_actor_input_large() {
	common::run(common::TestOpts::new(1), |ctx| async move {
		let (namespace, _, _runner) =
			common::setup_test_namespace_with_runner(ctx.leader_dc()).await;

		// Create a large input (1 MiB) that should succeed
		let input_size = 1024 * 1024;
		let input_data = "a".repeat(input_size);

		let res = common::api::public::actors_create(
			ctx.leader_dc().guard_port(),
			common::api_types::actors::create::CreateQuery {
				namespace: namespace.clone(),
			},
			common::api_types::actors::create::CreateRequest {
				datacenter: None,
				name: "test-actor".to_string(),
				key: None,
				input: Some(input_data),
				runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
				lane_hint: None,
				crash_policy: rivet_types::actors::CrashPolicy::Destroy,
			},
		)
		.await
		.expect("should succeed with large input");

		let actor_id = res.actor.actor_id.to_string();
		assert!(!actor_id.is_empty(), "actor ID should not be empty");
	});
}

#[test]
fn create_actor_input_exceeds_max_size() {
	common::run(common::TestOpts::new(1), |ctx| async move {
		let (namespace, _, _runner) =
			common::setup_test_namespace_with_runner(ctx.leader_dc()).await;

		// Create input exceeding 4 MiB
		let max_input_size = 4 * 1024 * 1024;
		let input_data = "a".repeat(max_input_size + 1);

		let res = common::api::public::actors_create(
			ctx.leader_dc().guard_port(),
			common::api_types::actors::create::CreateQuery {
				namespace: namespace.clone(),
			},
			common::api_types::actors::create::CreateRequest {
				datacenter: None,
				name: "test-actor".to_string(),
				key: None,
				input: Some(input_data),
				runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
				lane_hint: None,
				crash_policy: rivet_types::actors::CrashPolicy::Destroy,
			},
		)
		.await;

		assert!(
			res.is_err(),
			"should fail to create actor with input exceeding max size"
		);
	});
}

// MARK: Key validation tests
#[test]
fn create_actor_empty_key() {
	common::run(common::TestOpts::new(1), |ctx| async move {
		let (namespace, _, _runner) =
			common::setup_test_namespace_with_runner(ctx.leader_dc()).await;

		let res = common::api::public::actors_create(
			ctx.leader_dc().guard_port(),
			common::api_types::actors::create::CreateQuery {
				namespace: namespace.clone(),
			},
			common::api_types::actors::create::CreateRequest {
				datacenter: None,
				name: "test-actor".to_string(),
				key: Some("".to_string()),
				input: None,
				runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
				lane_hint: None,
				crash_policy: rivet_types::actors::CrashPolicy::Destroy,
			},
		)
		.await;

		assert!(res.is_err(), "should fail to create actor with empty key");
	});
}

#[test]
fn create_actor_key_at_max_size() {
	common::run(common::TestOpts::new(1), |ctx| async move {
		let (namespace, _, _runner) =
			common::setup_test_namespace_with_runner(ctx.leader_dc()).await;

		// Create key of exactly 1024 bytes
		let key = "a".repeat(1024);

		let res = common::api::public::actors_create(
			ctx.leader_dc().guard_port(),
			common::api_types::actors::create::CreateQuery {
				namespace: namespace.clone(),
			},
			common::api_types::actors::create::CreateRequest {
				datacenter: None,
				name: "test-actor".to_string(),
				key: Some(key.clone()),
				input: None,
				runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
				lane_hint: None,
				crash_policy: rivet_types::actors::CrashPolicy::Destroy,
			},
		)
		.await
		.expect("should succeed with key at max size");

		let actor_id = res.actor.actor_id.to_string();
		assert!(!actor_id.is_empty(), "actor ID should not be empty");

		// Verify actor exists with correct key
		let actor =
			common::assert_actor_exists(ctx.leader_dc().guard_port(), &actor_id, &namespace).await;
		assert_eq!(actor.key, Some(key));
	});
}

#[test]
fn create_actor_key_exceeds_max_size() {
	common::run(common::TestOpts::new(1), |ctx| async move {
		let (namespace, _, _runner) =
			common::setup_test_namespace_with_runner(ctx.leader_dc()).await;

		// Create key exceeding 1024 bytes
		let key = "a".repeat(1025);

		let res = common::api::public::actors_create(
			ctx.leader_dc().guard_port(),
			common::api_types::actors::create::CreateQuery {
				namespace: namespace.clone(),
			},
			common::api_types::actors::create::CreateRequest {
				datacenter: None,
				name: "test-actor".to_string(),
				key: Some(key),
				input: None,
				runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
				lane_hint: None,
				crash_policy: rivet_types::actors::CrashPolicy::Destroy,
			},
		)
		.await;

		assert!(
			res.is_err(),
			"should fail to create actor with key exceeding max size"
		);
	});
}
