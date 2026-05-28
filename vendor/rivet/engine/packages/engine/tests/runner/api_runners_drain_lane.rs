use super::super::common;

use std::{collections::HashSet, time::Duration};

use futures_util::future::join_all;

#[test]
fn drain_lane_marks_runner_draining() {
	common::run(common::TestOpts::new(1), |ctx| async move {
		let (namespace, _, _runner) =
			common::setup_test_namespace_with_runner(ctx.leader_dc()).await;
		let guard_port = ctx.leader_dc().guard_port();

		let response = common::api::public::runners_drain_lane(
			guard_port,
			rivet_api_types::runners::drain_lane::DrainLanePath {
				runner_name: common::TEST_RUNNER_NAME.to_owned(),
			},
			rivet_api_types::runners::drain_lane::DrainLaneQuery {
				namespace: namespace.clone(),
			},
			rivet_api_types::runners::drain_lane::DrainLaneRequest {
				lane: None,
				reset_actor_rescheduling: true,
			},
		)
		.await
		.expect("failed to drain runner lane");

		assert!(
			!response.runner_workflow_ids.is_empty(),
			"drain-lane route should target the connected runner workflow"
		);

		let drained_runner =
			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let namespace = namespace.clone();
				async move {
					let runners = common::api::public::runners_list(
						guard_port,
						rivet_api_types::runners::list::ListQuery {
							namespace,
							name: Some(common::TEST_RUNNER_NAME.to_owned()),
							runner_ids: None,
							runner_id: vec![],
							include_stopped: Some(true),
							limit: None,
							cursor: None,
						},
					)
					.await
					.ok()?;

					runners.runners.into_iter().find(|runner| {
						runner.name == common::TEST_RUNNER_NAME && runner.drain_ts.is_some()
					})
				}
			})
			.await
			.expect("runner should enter draining state after lane drain route");

		assert_eq!(common::TEST_RUNNER_NAME, drained_runner.name);
	});
}

#[test]
fn drain_lane_targets_requested_worker_lane() {
	common::run(common::TestOpts::new(1), |ctx| async move {
		let (namespace, _) = common::setup_test_namespace(ctx.leader_dc()).await;
		let default_runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
			builder
				.with_runner_key("default-lane-key")
				.with_runner_name(common::TEST_RUNNER_NAME)
		})
		.await;
		let cpu_runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
			builder
				.with_runner_key("cpu-heavy-lane-key")
				.with_runner_name(common::TEST_RUNNER_NAME)
				.with_lane("cpu-heavy")
		})
		.await;
		let default_runner_id = default_runner.wait_ready().await;
		let cpu_runner_id = cpu_runner.wait_ready().await;
		let guard_port = ctx.leader_dc().guard_port();

		let response = common::api::public::runners_drain_lane(
			guard_port,
			rivet_api_types::runners::drain_lane::DrainLanePath {
				runner_name: common::TEST_RUNNER_NAME.to_owned(),
			},
			rivet_api_types::runners::drain_lane::DrainLaneQuery {
				namespace: namespace.clone(),
			},
			rivet_api_types::runners::drain_lane::DrainLaneRequest {
				lane: Some("cpu-heavy".to_owned()),
				reset_actor_rescheduling: true,
			},
		)
		.await
		.expect("failed to drain cpu-heavy runner lane");

		assert_eq!(
			1,
			response.runner_workflow_ids.len(),
			"draining cpu-heavy should target only the non-default lane runner"
		);

		let runners =
			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let namespace = namespace.clone();
				let cpu_runner_id = cpu_runner_id.clone();
				async move {
					let runners = common::api::public::runners_list(
						guard_port,
						rivet_api_types::runners::list::ListQuery {
							namespace,
							name: Some(common::TEST_RUNNER_NAME.to_owned()),
							runner_ids: None,
							runner_id: vec![],
							include_stopped: Some(true),
							limit: None,
							cursor: None,
						},
					)
					.await
					.ok()?;

					let cpu_drained = runners.runners.iter().any(|runner| {
						runner.runner_id.to_string() == cpu_runner_id && runner.drain_ts.is_some()
					});

					cpu_drained.then_some(runners.runners)
				}
			})
			.await
			.expect("cpu-heavy runner should enter draining state");

		let default_runner = runners
			.iter()
			.find(|runner| runner.runner_id.to_string() == default_runner_id)
			.expect("default runner should still be listed");
		let cpu_runner = runners
			.iter()
			.find(|runner| runner.runner_id.to_string() == cpu_runner_id)
			.expect("cpu-heavy runner should still be listed");

		assert!(
			default_runner.drain_ts.is_none(),
			"default lane runner should not be drained by a cpu-heavy lane request"
		);
		assert_eq!("default", default_runner.lane);
		assert_eq!("cpu-heavy", cpu_runner.lane);
		assert!(
			cpu_runner.drain_ts.is_some(),
			"cpu-heavy runner should be drained by a cpu-heavy lane request"
		);
	});
}

#[test]
fn drain_lane_reschedules_active_actor_to_replacement_lane() {
	common::run(
		common::TestOpts::new(1).with_timeout(45),
		|ctx| async move {
			let (namespace, _) = common::setup_test_namespace(ctx.leader_dc()).await;
			let guard_port = ctx.leader_dc().guard_port();
			let old_runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
				builder
					.with_runner_key("replace-old-cpu-heavy-key")
					.with_runner_name(common::TEST_RUNNER_NAME)
					.with_lane("cpu-heavy")
					.with_total_slots(1)
			})
			.await;

			let actor = common::api::public::actors_create(
				guard_port,
				common::api_types::actors::create::CreateQuery {
					namespace: namespace.clone(),
				},
				common::api_types::actors::create::CreateRequest {
					datacenter: None,
					name: "test-actor".to_string(),
					key: Some("drain-replace-cpu-heavy".to_string()),
					input: None,
					runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
					lane_hint: Some("cpu-heavy".to_string()),
					crash_policy: rivet_types::actors::CrashPolicy::Restart,
				},
			)
			.await
			.expect("failed to create restartable cpu-heavy actor");
			let actor_id = actor.actor.actor_id.to_string();

			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let old_runner = &old_runner;
				let actor_id = actor_id.clone();
				async move { old_runner.has_actor(&actor_id).await.then_some(()) }
			})
			.await
			.expect("actor should start on the original cpu-heavy runner");

			let response = common::api::public::runners_drain_lane(
				guard_port,
				rivet_api_types::runners::drain_lane::DrainLanePath {
					runner_name: common::TEST_RUNNER_NAME.to_owned(),
				},
				rivet_api_types::runners::drain_lane::DrainLaneQuery {
					namespace: namespace.clone(),
				},
				rivet_api_types::runners::drain_lane::DrainLaneRequest {
					lane: Some("cpu-heavy".to_owned()),
					reset_actor_rescheduling: true,
				},
			)
			.await
			.expect("failed to drain active cpu-heavy runner lane");

			assert_eq!(
				1,
				response.runner_workflow_ids.len(),
				"drain should target only the original cpu-heavy runner"
			);

			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let old_runner = &old_runner;
				let actor_id = actor_id.clone();
				async move { (!old_runner.has_actor(&actor_id).await).then_some(()) }
			})
			.await
			.expect("drained runner should stop the actor before replacement");

			let replacement_runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
				builder
					.with_runner_key("replace-new-cpu-heavy-key")
					.with_runner_name(common::TEST_RUNNER_NAME)
					.with_lane("cpu-heavy")
					.with_total_slots(1)
			})
			.await;

			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let replacement_runner = &replacement_runner;
				let actor_id = actor_id.clone();
				async move { replacement_runner.has_actor(&actor_id).await.then_some(()) }
			})
			.await
			.expect("replacement cpu-heavy runner should receive rescheduled actor");

			assert!(
				!old_runner.has_actor(&actor_id).await,
				"drained runner should not retain the actor after replacement"
			);

			let actor = common::try_get_actor(guard_port, &actor_id, &namespace)
				.await
				.expect("actor get request should succeed")
				.expect("actor should still exist after drain replacement");
			assert!(
				actor.destroy_ts.is_none(),
				"restartable actor should not be destroyed by lane drain"
			);
			assert!(
				actor.pending_allocation_ts.is_none(),
				"actor should not remain pending after replacement runner starts"
			);
		},
	);
}

#[test]
fn drain_lane_reschedules_active_cohort_to_replacement_lane() {
	common::run(
		common::TestOpts::new(1).with_timeout(60),
		|ctx| async move {
			let (namespace, _) = common::setup_test_namespace(ctx.leader_dc()).await;
			let guard_port = ctx.leader_dc().guard_port();
			let default_runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
				builder
					.with_runner_key("replace-cohort-default-key")
					.with_runner_name(common::TEST_RUNNER_NAME)
					.with_total_slots(8)
			})
			.await;
			let mut old_runners = Vec::new();

			for idx in 0..2 {
				let runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
					builder
						.with_runner_key(&format!("replace-cohort-old-cpu-heavy-key-{idx}"))
						.with_runner_name(common::TEST_RUNNER_NAME)
						.with_lane("cpu-heavy")
						.with_total_slots(2)
				})
				.await;

				old_runners.push(runner);
			}

			let actor_ids = join_all((0..4).map(|idx| {
				let namespace = namespace.clone();

				async move {
					common::api::public::actors_create(
						guard_port,
						common::api_types::actors::create::CreateQuery { namespace },
						common::api_types::actors::create::CreateRequest {
							datacenter: None,
							name: "test-actor".to_string(),
							key: Some(format!("drain-replace-cohort-cpu-heavy-{idx}")),
							input: None,
							runner_name_selector: common::TEST_RUNNER_NAME.to_string(),
							lane_hint: Some("cpu-heavy".to_string()),
							crash_policy: rivet_types::actors::CrashPolicy::Restart,
						},
					)
					.await
					.expect("failed to create restartable cpu-heavy cohort actor")
					.actor
					.actor_id
					.to_string()
				}
			}))
			.await;
			let expected_actor_ids: HashSet<_> = actor_ids.iter().cloned().collect();

			let old_counts =
				common::wait_with_poll(Duration::from_secs(15), Duration::from_millis(100), || {
					let expected_actor_ids = expected_actor_ids.clone();
					let old_runners = &old_runners;

					async move {
						let mut actor_ids = HashSet::new();
						let mut counts = Vec::new();

						for runner in old_runners {
							let runner_actor_ids = runner.get_actor_ids().await;
							counts.push(runner_actor_ids.len());
							actor_ids.extend(runner_actor_ids);
						}

						(actor_ids == expected_actor_ids).then_some(counts)
					}
				})
				.await
				.expect("cohort should start on the original cpu-heavy runners");
			assert!(
				old_counts.iter().all(|count| *count <= 2),
				"old cpu-heavy runner capacity should cap each runner at two actors: {old_counts:?}"
			);
			let mut sorted_old_counts = old_counts;
			sorted_old_counts.sort_unstable();
			assert_eq!(
				vec![2, 2],
				sorted_old_counts,
				"cohort should use all original cpu-heavy runner capacity"
			);
			assert!(
				default_runner.get_actor_ids().await.is_empty(),
				"default runner should not receive cpu-heavy cohort actors before drain"
			);

			let response = common::api::public::runners_drain_lane(
				guard_port,
				rivet_api_types::runners::drain_lane::DrainLanePath {
					runner_name: common::TEST_RUNNER_NAME.to_owned(),
				},
				rivet_api_types::runners::drain_lane::DrainLaneQuery {
					namespace: namespace.clone(),
				},
				rivet_api_types::runners::drain_lane::DrainLaneRequest {
					lane: Some("cpu-heavy".to_owned()),
					reset_actor_rescheduling: true,
				},
			)
			.await
			.expect("failed to drain active cpu-heavy runner lane");

			assert_eq!(
				2,
				response.runner_workflow_ids.len(),
				"drain should target only the original cpu-heavy runners"
			);

			common::wait_with_poll(Duration::from_secs(10), Duration::from_millis(100), || {
				let expected_actor_ids = expected_actor_ids.clone();
				let old_runners = &old_runners;

				async move {
					let mut actor_ids = HashSet::new();

					for runner in old_runners {
						actor_ids.extend(runner.get_actor_ids().await);
					}

					actor_ids.is_disjoint(&expected_actor_ids).then_some(())
				}
			})
			.await
			.expect("drained runner should stop every cohort actor before replacement");

			let mut replacement_runners = Vec::new();

			for idx in 0..2 {
				let runner = common::setup_runner(ctx.leader_dc(), &namespace, |builder| {
					builder
						.with_runner_key(&format!("replace-cohort-new-cpu-heavy-key-{idx}"))
						.with_runner_name(common::TEST_RUNNER_NAME)
						.with_lane("cpu-heavy")
						.with_total_slots(2)
				})
				.await;

				replacement_runners.push(runner);
			}

			let replacement_counts =
				common::wait_with_poll(Duration::from_secs(15), Duration::from_millis(100), || {
					let expected_actor_ids = expected_actor_ids.clone();
					let replacement_runners = &replacement_runners;

					async move {
						let mut actor_ids = HashSet::new();
						let mut counts = Vec::new();

						for runner in replacement_runners {
							let runner_actor_ids = runner.get_actor_ids().await;
							counts.push(runner_actor_ids.len());
							actor_ids.extend(runner_actor_ids);
						}

						(actor_ids == expected_actor_ids).then_some(counts)
					}
				})
				.await
				.expect("replacement cpu-heavy runners should receive every cohort actor");
			assert!(
				replacement_counts.iter().all(|count| *count <= 2),
				"replacement cpu-heavy runner capacity should cap each runner at two actors: {replacement_counts:?}"
			);
			let mut sorted_replacement_counts = replacement_counts;
			sorted_replacement_counts.sort_unstable();
			assert_eq!(
				vec![2, 2],
				sorted_replacement_counts,
				"cohort should use all replacement cpu-heavy runner capacity"
			);

			assert!(
				default_runner.get_actor_ids().await.is_empty(),
				"default runner should not receive cpu-heavy actors during lane drain replacement"
			);

			for actor_id in actor_ids {
				let actor = common::try_get_actor(guard_port, &actor_id, &namespace)
					.await
					.expect("actor get request should succeed")
					.expect("actor should still exist after drain replacement");
				assert!(
					actor.destroy_ts.is_none(),
					"restartable actor should not be destroyed by lane drain"
				);
				assert!(
					actor.pending_allocation_ts.is_none(),
					"actor should not remain pending after replacement runner starts"
				);
			}
		},
	);
}
