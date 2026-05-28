use futures_util::FutureExt;
use gas::prelude::*;
use rivet_runner_protocol as protocol;
use rivet_types::actors::{Actor, CrashPolicy};

use crate::{errors, workflows::runner2::AllocatePendingActorsInput};

mod destroy;
mod keys;
pub mod metrics;
mod runtime;
mod setup;

pub use runtime::AllocationOverride;

/// Batch size of how many events to ack.
const EVENT_ACK_BATCH_SIZE: i64 = 250;
/// Keep first-start actor metrics bookkeeping out of large setup fan-in windows.
const INITIAL_METRICS_RESUME_DELAY_MS: i64 = util::duration::minutes(2);
/// How long an actor with crash_policy Restart should wait pending before setting itself to sleep.
const RESTART_PENDING_TIMEOUT_MS: i64 = util::duration::seconds(60);
const SLOW_ACTOR_SETUP_HOP_MS: u128 = 1000;

pub(super) fn log_slow_actor_setup_hop(
	actor_id: Id,
	setup_hop: &'static str,
	duration: std::time::Duration,
) {
	let setup_hop_duration_ms = duration.as_millis();
	if setup_hop_duration_ms >= SLOW_ACTOR_SETUP_HOP_MS {
		tracing::warn!(
			?actor_id,
			setup_hop,
			setup_hop_duration_ms,
			"slow actor setup hop"
		);
	}
}

pub(super) fn log_slow_actor_setup_tx_hop(
	actor_id: Id,
	setup_hop: &'static str,
	duration: std::time::Duration,
	setup_attempts: usize,
	setup_tx_inner_duration_ms: u64,
	setup_tx_commit_retry_duration_ms: u64,
) {
	let setup_hop_duration_ms = duration.as_millis();
	if setup_hop_duration_ms >= SLOW_ACTOR_SETUP_HOP_MS {
		tracing::warn!(
			?actor_id,
			setup_hop,
			setup_hop_duration_ms,
			setup_attempts,
			setup_tx_inner_duration_ms,
			setup_tx_commit_retry_duration_ms,
			"slow actor setup hop"
		);
	}
}

#[derive(Clone, Debug, Serialize, Deserialize, Hash)]
pub struct Input {
	pub actor_id: Id,
	pub name: String,
	pub key: Option<String>,

	pub namespace_id: Id,
	pub runner_name_selector: String,
	#[serde(default)]
	pub lane_hint: Option<String>,
	pub crash_policy: CrashPolicy,

	/// Arbitrary user-provided binary encoded in base64. We assume this is valid base64.
	pub input: Option<String>,
}

#[workflow]
#[prune = history] // Don't prune state, required for actor::list_for_ns
pub async fn pegboard_actor(ctx: &mut WorkflowCtx, input: &Input) -> Result<()> {
	let workflow_started = std::time::Instant::now();
	let workflow_first_start_lag_ms = (util::timestamp::now() - ctx.create_ts()).max(0) as u128;
	if ctx.is_first_run() && workflow_first_start_lag_ms >= SLOW_ACTOR_SETUP_HOP_MS {
		tracing::warn!(
			actor_id = ?input.actor_id,
			workflow_first_start_lag_ms,
			"slow actor workflow first start"
		);
	}

	// Actor creation follows a careful sequence to prevent race conditions:
	//
	// 1. **Add actor to UDB with no indexes** This ensures any services attempting on this actor
	//    by ID will find it exists, even before creation is complete.
	//
	// 2. **Reserve the key with Epoxy** This is slow as it traverses datacenters globally to
	//    ensure key is unique across the entire system. We do this before adding to indexes to
	//    prevent showing the actor in API requests before the creation is complete.
	//
	// 3. **Add actor to relevant indexes** Only done after confirming Epoxy key is reserved. If
	//    we added to indexes before Epoxy validation, actors could appear in lists with duplicate
	//    key (since reservation wasn't confirmed yet).

	let mut create_indexes_added = false;
	let keyed_setup_version = ctx.check_version(8).await?;
	let use_combined_keyed_create = use_combined_keyed_create_version(keyed_setup_version);
	if use_combined_keyed_create && let Some(key) = &input.key {
		let hop_started = std::time::Instant::now();
		let create_ts = ctx.create_ts();
		let prepare_input = setup::PrepareKeyedCreateInput {
			actor_id: input.actor_id,
			name: input.name.clone(),
			key: key.clone(),
			namespace_id: input.namespace_id,
			runner_name_selector: input.runner_name_selector.clone(),
			lane_hint: input.lane_hint.clone(),
			crash_policy: input.crash_policy,
			create_ts,
			input: input.input.clone(),
		};
		let prepare_res = if use_fused_keyed_create_version(keyed_setup_version) {
			ctx.v(keyed_setup_version)
				.activity(setup::PrepareKeyedCreateCombinedUdbInput::from(
					prepare_input,
				))
				.await?
		} else {
			ctx.v(keyed_setup_version).activity(prepare_input).await?
		};
		log_slow_actor_setup_hop(
			input.actor_id,
			"prepare_keyed_create",
			hop_started.elapsed(),
		);

		match prepare_res {
			setup::PrepareKeyedCreateOutput::ValidationFailed { error } => {
				ctx.msg(Failed { error })
					.topic(("actor_id", input.actor_id))
					.send()
					.await?;

				return Ok(());
			}
			setup::PrepareKeyedCreateOutput::Complete { reserve_result } => {
				if matches!(&reserve_result, keys::ReserveKeyOutput::Success) {
					create_indexes_added = true;
				}
				if !handle_reserve_key_output(ctx, input, key, reserve_result).await? {
					return Ok(());
				}
			}
		}
	} else {
		let hop_started = std::time::Instant::now();
		let validation_res = ctx
			.activity(setup::ValidateInput {
				name: input.name.clone(),
				key: input.key.clone(),
				namespace_id: input.namespace_id,
				input: input.input.clone(),
			})
			.await?;
		log_slow_actor_setup_hop(input.actor_id, "validate", hop_started.elapsed());

		if let Err(error) = validation_res {
			ctx.msg(Failed { error })
				.topic(("actor_id", input.actor_id))
				.send()
				.await?;

			return Ok(());
		}

		let hop_started = std::time::Instant::now();
		ctx.activity(setup::InitStateAndUdbInput {
			actor_id: input.actor_id,
			name: input.name.clone(),
			key: input.key.clone(),
			namespace_id: input.namespace_id,
			runner_name_selector: input.runner_name_selector.clone(),
			lane_hint: input.lane_hint.clone(),
			crash_policy: input.crash_policy,
			create_ts: ctx.create_ts(),
		})
		.await?;
		log_slow_actor_setup_hop(input.actor_id, "init_state_and_udb", hop_started.elapsed());

		let hop_started = std::time::Instant::now();
		match ctx.check_version(2).await? {
			1 => {
				ctx.v(2)
					.activity(setup::BackfillUdbKeysAndMetricsInput {
						actor_id: input.actor_id,
					})
					.await?;
			}
			_latest => {
				// Do nothing, already using the new version of init_state_and_udb which has the new udb keys and
				// metrics
			}
		}
		log_slow_actor_setup_hop(input.actor_id, "version_backfill", hop_started.elapsed());

		if let Some(key) = &input.key {
			let hop_started = std::time::Instant::now();
			let reserve_res = match ctx.check_version(4).await? {
				1 | 2 => {
					keys::reserve_key_legacy(
						ctx,
						input.namespace_id,
						input.name.clone(),
						key.clone(),
						input.actor_id,
						input.runner_name_selector.clone(),
					)
					.await?
				}
				3 => {
					keys::reserve_key(
						ctx,
						input.namespace_id,
						input.name.clone(),
						key.clone(),
						input.actor_id,
						input.runner_name_selector.clone(),
					)
					.await?
				}
				_latest => {
					let res = keys::reserve_key_and_add_indexes(
						ctx,
						input.namespace_id,
						input.name.clone(),
						key.clone(),
						input.actor_id,
						input.runner_name_selector.clone(),
					)
					.await?;
					if matches!(&res, keys::ReserveKeyOutput::Success) {
						create_indexes_added = true;
					}
					res
				}
			};

			if !handle_reserve_key_output(ctx, input, key, reserve_res).await? {
				return Ok(());
			}
			log_slow_actor_setup_hop(input.actor_id, "reserve_key", hop_started.elapsed());
		}
	}

	if !create_indexes_added {
		let hop_started = std::time::Instant::now();
		ctx.activity(setup::AddIndexesAndSetCreateCompleteInput {
			actor_id: input.actor_id,
		})
		.await?;
		log_slow_actor_setup_hop(
			input.actor_id,
			"add_indexes_and_set_create_complete",
			hop_started.elapsed(),
		);
	}

	let hop_started = std::time::Instant::now();
	ctx.msg(CreateComplete {
		actor: Some(Actor {
			actor_id: input.actor_id,
			name: input.name.clone(),
			key: input.key.clone(),
			namespace_id: input.namespace_id,
			datacenter: ctx.config().dc_name()?.to_string(),
			runner_name_selector: input.runner_name_selector.clone(),
			crash_policy: input.crash_policy,
			create_ts: ctx.create_ts(),
			start_ts: None,
			pending_allocation_ts: None,
			connectable_ts: None,
			sleep_ts: None,
			reschedule_ts: None,
			destroy_ts: None,
			error: None,
		}),
	})
	.topic(("actor_id", input.actor_id))
	.send()
	.await?;
	log_slow_actor_setup_hop(input.actor_id, "create_complete_msg", hop_started.elapsed());

	let pre_spawn_duration_ms = workflow_started.elapsed().as_millis();
	if pre_spawn_duration_ms >= 1000 {
		tracing::warn!(
			actor_id = ?input.actor_id,
			pre_spawn_duration_ms,
			"slow actor pre-spawn setup"
		);
	}

	let spawn_started = std::time::Instant::now();
	let spawn_res = runtime::spawn_actor(ctx, input, 0, AllocationOverride::None).await?;
	let spawn_duration_ms = spawn_started.elapsed().as_millis();
	let spawn_status = match &spawn_res {
		runtime::SpawnActorOutput::Allocated { .. } => "allocated",
		runtime::SpawnActorOutput::Sleep => "sleep",
		runtime::SpawnActorOutput::Destroy => "destroy",
		runtime::SpawnActorOutput::MigrateToV2 => "migrate_to_v2",
	};
	if spawn_duration_ms >= 1000 {
		tracing::warn!(
			actor_id = ?input.actor_id,
			status = spawn_status,
			spawn_duration_ms,
			"slow actor initial spawn"
		);
	}

	let lifecycle_state = match spawn_res {
		runtime::SpawnActorOutput::Allocated {
			runner_id,
			runner_workflow_id,
			runner_protocol_version,
		} => runtime::LifecycleState::new(
			runner_id,
			runner_workflow_id,
			runner_protocol_version,
			ctx.config().pegboard().actor_start_threshold(),
		),
		runtime::SpawnActorOutput::Sleep => {
			ctx.activity(runtime::SetSleepingInput {
				actor_id: input.actor_id,
			})
			.await?;

			runtime::LifecycleState::new_sleeping()
		}
		runtime::SpawnActorOutput::Destroy => {
			// Destroyed early
			ctx.workflow(destroy::Input {
				namespace_id: input.namespace_id,
				actor_id: input.actor_id,
				name: input.name.clone(),
				key: input.key.clone(),
				generation: 0,
			})
			.output()
			.await?;

			return Ok(());
		}
		runtime::SpawnActorOutput::MigrateToV2 => {
			ctx.workflow(crate::workflows::actor2::Input {
				actor_id: input.actor_id,
				name: input.name.clone(),
				pool_name: input.runner_name_selector.clone(),
				key: input.key.clone(),
				namespace_id: input.namespace_id,
				input: input.input.clone(),
				from_v1: true,
				lane_hint: input.lane_hint.clone(),
			})
			.tag("actor_id", input.actor_id)
			.dispatch()
			.await?;

			ctx.msg(MigratedToV2 {})
				.topic(("actor_id", input.actor_id))
				.send()
				.await?;

			return Ok(());
		}
	};

	let lifecycle_res = ctx.lupe()
		.commit_interval(1)
		.with_state(lifecycle_state)
		.run(|ctx, state| {
			let input = input.clone();

			async move {
				let signals = listen_for_actor_signals(ctx, &input, state).await?;

				for sig in signals {
					match sig {
						// NOTE: This is only received when allocated to mk1 runner
						Main::Event(sig) => {
							let (
								Some(runner_id),
								Some(runner_workflow_id),
							) = (
								state.runner_id,
								state.runner_workflow_id,
							)
							else {
								tracing::warn!(?sig, "actor not allocated, ignoring event");
								continue;
							};

							// Ignore events for previous generations
							if crate::utils::event_generation_mk1(&sig.inner) != state.generation {
								continue;
							}

							match sig.inner {
								protocol::Event::EventActorIntent(protocol::EventActorIntent {
									intent,
									..
								}) => match intent {
									protocol::ActorIntent::ActorIntentSleep => {
										if !state.sleeping {
											state.gc_timeout_ts = Some(
												util::timestamp::now()
													+ ctx
														.config()
														.pegboard()
														.actor_stop_threshold(),
											);
											state.sleeping = true;

											ctx.activity(runtime::SetSleepingInput {
												actor_id: input.actor_id,
											})
											.await?;

											// Send signal to stop actor now that we know it will be sleeping
											ctx.signal(crate::workflows::runner::Command {
												inner: protocol::Command::CommandStopActor(
													protocol::CommandStopActor {
														actor_id: input.actor_id.to_string(),
														generation: state.generation,
													},
												),
											})
											.to_workflow_id(runner_workflow_id)
											.send()
											.await?;
										}
									}
									protocol::ActorIntent::ActorIntentStop => {
										if !state.stopping {
											state.gc_timeout_ts = Some(
												util::timestamp::now()
													+ ctx
														.config()
														.pegboard()
														.actor_stop_threshold(),
											);
											state.stopping = true;

											ctx.activity(runtime::SetNotConnectableInput {
												actor_id: input.actor_id,
											})
											.await?;

											ctx.signal(crate::workflows::runner::Command {
												inner: protocol::Command::CommandStopActor(
													protocol::CommandStopActor {
														actor_id: input.actor_id.to_string(),
														generation: state.generation,
													},
												),
											})
											.to_workflow_id(runner_workflow_id)
											.send()
											.await?;
										}
									}
								},
								protocol::Event::EventActorStateUpdate(
									protocol::EventActorStateUpdate {
										state: actor_state, ..
									},
								) => match actor_state {
									protocol::ActorState::ActorStateRunning => {
										state.gc_timeout_ts = None;

										ctx.activity(runtime::SetStartedInput {
											actor_id: input.actor_id,
											runner_id,
											generation: state.generation,
										})
										.await?;

										ctx.msg(Ready { runner_id })
											.topic(("actor_id", input.actor_id))
											.send()
											.await?;
										resume_or_schedule_metrics_workflow(ctx, &input, state).await?;
									}
									protocol::ActorState::ActorStateStopped(
										protocol::ActorStateStopped { code, message },
									) => {
										match handle_stopped(
											ctx,
											&input,
											state,
											StoppedVariant::Normal {
												code: match code {
													protocol::StopCode::Ok => protocol::mk2::StopCode::Ok,
													protocol::StopCode::Error => protocol::mk2::StopCode::Error,
												},
												message,
											},
										)
										.await?
										{
											StoppedResult::Continue => {}
											StoppedResult::Destroy => {
												return Ok(Loop::Break(state.result(false)));
											}
											StoppedResult::MigrateToV2 => {
												return Ok(Loop::Break(state.result(true)));
											}
										}
									}
								},
								protocol::Event::EventActorSetAlarm(
									protocol::EventActorSetAlarm { alarm_ts, .. },
								) => {
									state.alarm_ts = alarm_ts;

									ctx.activity(runtime::RecordEventMetricsInput {
										namespace_id: input.namespace_id,
										name: input.name.clone(),
										alarms_set: 1,
									}).await?;
								}
							}
						}
						// NOTE: This signal is only received when allocated to a mk2 runner
						Main::Events(sig) => {
							let Some(runner_id) = state.runner_id else {
								tracing::warn!(?sig, "actor not allocated, ignoring events");
								continue;
							};

							if sig.runner_id != runner_id {
								tracing::debug!("events not from current runner, ignoring");
								continue;
							}

							// Fetch the last event index for the current runner
							let last_event_idx =
								state.runner_state.get_or_insert_default().last_event_idx;

							// Filter already received events and events from previous generations
							let generation = state.generation;
							let new_events = sig.events
								.iter()
								.filter(|event| {
									event.checkpoint.generation == generation &&
									event.checkpoint.index > last_event_idx
								});
							let mut new_event_count = 0;
							let new_last_event_idx =
								new_events.clone().last().map(|event| event.checkpoint.index);
							let mut alarms_set = 0;

							for event in new_events {
								new_event_count += 1;

								match &event.inner {
									protocol::mk2::Event::EventActorIntent(
										protocol::mk2::EventActorIntent { intent, .. },
									) => match intent {
										protocol::mk2::ActorIntent::ActorIntentSleep => {
											if !state.sleeping {
												state.gc_timeout_ts = Some(
													util::timestamp::now()
														+ ctx
															.config()
															.pegboard()
															.actor_stop_threshold(),
												);
												state.sleeping = true;

												ctx.activity(runtime::SetSleepingInput {
													actor_id: input.actor_id,
												})
												.await?;

												ctx.activity(runtime::InsertAndSendCommandsInput {
													actor_id: input.actor_id,
													generation: state.generation,
													runner_id,
													commands: vec![protocol::mk2::Command::CommandStopActor],
												})
												.await?;
											}
										}
										protocol::mk2::ActorIntent::ActorIntentStop => {
											if !state.stopping {
												state.gc_timeout_ts = Some(
													util::timestamp::now()
														+ ctx
															.config()
															.pegboard()
															.actor_stop_threshold(),
												);
												state.stopping = true;

												ctx.activity(runtime::SetNotConnectableInput {
													actor_id: input.actor_id,
												})
												.await?;

												ctx.activity(runtime::InsertAndSendCommandsInput {
													actor_id: input.actor_id,
													generation: state.generation,
													runner_id,
													commands: vec![protocol::mk2::Command::CommandStopActor],
												})
												.await?;
											}
										}
									},
									protocol::mk2::Event::EventActorStateUpdate(
										protocol::mk2::EventActorStateUpdate {
											state: actor_state,
											..
										},
									) => match actor_state {
										protocol::mk2::ActorState::ActorStateRunning => {
											state.gc_timeout_ts = None;

											ctx.activity(runtime::SetStartedInput {
												actor_id: input.actor_id,
												runner_id,
												generation: state.generation,
											})
											.await?;

											ctx.msg(Ready { runner_id })
												.topic(("actor_id", input.actor_id))
												.send()
												.await?;
											resume_or_schedule_metrics_workflow(ctx, &input, state).await?;
										}
										protocol::mk2::ActorState::ActorStateStopped(
											protocol::mk2::ActorStateStopped { code, message },
										) => {
											match handle_stopped(
												ctx,
												&input,
												state,
												StoppedVariant::Normal {
													code: code.clone(),
													message: message.clone(),
												},
											)
											.await?
											{
												StoppedResult::Continue => {}
												StoppedResult::Destroy => {
													return Ok(Loop::Break(state.result(false)));
												}
												StoppedResult::MigrateToV2 => {
													return Ok(Loop::Break(state.result(true)));
												}
											}
										}
									},
									protocol::mk2::Event::EventActorSetAlarm(
										protocol::mk2::EventActorSetAlarm { alarm_ts, .. },
									) => {
										state.alarm_ts = *alarm_ts;
										alarms_set += 1;
									}
								}
							}

							let diff = sig.events.len().saturating_sub(new_event_count);
							if diff != 0 {
								tracing::warn!(count=%diff, "ignored events due to generation/index filter");
							}

							ctx.join((
								if let (Some(runner_state), Some(new_last_event_idx)) = (state.runner_state.as_mut(), new_last_event_idx) {
									runner_state.last_event_idx = runner_state.last_event_idx.max(new_last_event_idx);

									// Ack events in batch
									if runner_state.last_event_idx
										> runner_state.last_event_ack_idx.saturating_add(EVENT_ACK_BATCH_SIZE)
									{
										runner_state.last_event_ack_idx = runner_state.last_event_idx;

										Some(activity(runtime::SendMessagesToRunnerInput {
											runner_id,
											messages: vec![protocol::mk2::ToRunner::ToClientAckEvents(
												protocol::mk2::ToClientAckEvents {
													last_event_checkpoints: vec![
														protocol::mk2::ActorCheckpoint {
															actor_id: input.actor_id.to_string(),
															generation: state.generation,
															index: runner_state.last_event_ack_idx,
														},
													],
												},
											)],
										}))
									} else {
										None
									}
								} else {
									None
								},
								(alarms_set > 0).then(|| activity(runtime::RecordEventMetricsInput {
									namespace_id: input.namespace_id,
									name: input.name.clone(),
									alarms_set,
								}))
							)).await?;
						}
						Main::Wake(sig) => {
							tracing::debug!(
								actor_id = ?input.actor_id,
								sleeping = state.sleeping,
								runner_id = ?state.runner_id,
								will_wake = state.will_wake,
								"received wake signal"
							);

							// Clear alarm
							if let Some(alarm_ts) = state.alarm_ts {
								let now = ctx.v(3).activity(GetTsInput {}).await?;

								if now >= alarm_ts {
									state.alarm_ts = None;
								}
							}

							if state.sleeping {
								if state.runner_id.is_none() {
									state.sleeping = false;
									state.will_wake = false;

									match runtime::reschedule_actor(
										ctx,
										&input,
										state,
										sig.allocation_override,
									)
									.await?
									{
										runtime::SpawnActorOutput::Allocated { .. } => {}
										runtime::SpawnActorOutput::Sleep => {
											state.sleeping = true;

											// We do not have to run set_sleeping here because the actor went
											// from sleeping -> attempt allocation -> sleeping. It was never
											// allocated
										}
										runtime::SpawnActorOutput::Destroy => {
											// Destroyed early
											return Ok(Loop::Break(state.result(false)));
										}
										runtime::SpawnActorOutput::MigrateToV2 => {
											return Ok(Loop::Break(state.result(true)));
										}
									}
								} else if !state.will_wake {
									state.will_wake = true;

									tracing::debug!(
										actor_id=?input.actor_id,
										"cannot wake an actor that intends to sleep but has not stopped yet, deferring wake until after stop",
									);
								}
							} else {
								tracing::debug!(
									actor_id=?input.actor_id,
									"cannot wake actor that is not sleeping",
								);
							}
						}
						Main::Lost(sig) => {
							// Ignore signals for previous generations
							if sig.generation != state.generation {
								continue;
							}

							if sig.reset_rescheduling {
								state.reschedule_state = Default::default();
							}

							// Build failure reason from lost reason
							let failure_reason = if let Some(runner_id) = state.runner_id {
                                 match &sig.reason {
									Some(LostReason::RunnerNoResponse) => {
										Some(FailureReason::RunnerNoResponse { runner_id })
									}
									Some(LostReason::RunnerConnectionLost) => {
										Some(FailureReason::RunnerConnectionLost { runner_id })
									}
									Some(LostReason::RunnerDrainingTimeout) => {
										Some(FailureReason::RunnerDrainingTimeout { runner_id })
									}
									// Draining is expected, no error needed
									Some(LostReason::RunnerDraining) => None,
									// Legacy signal without reason
									None => None,
                                }
                            } else {
								None
                            };

							match handle_stopped(
								ctx,
								&input,
								state,
								StoppedVariant::Lost {
									force_reschedule: sig.force_reschedule,
									failure_reason,
								},
							)
							.await?
							{
								StoppedResult::Continue => {}
								StoppedResult::Destroy => {
									return Ok(Loop::Break(state.result(false)));
								}
								StoppedResult::MigrateToV2 => {
									return Ok(Loop::Break(state.result(true)));
								}
							}
						}
						Main::GoingAway(sig) => {
							// Ignore signals for previous generations
							if sig.generation != state.generation {
								continue;
							}

							if sig.reset_rescheduling {
								state.reschedule_state = Default::default();
							}

							if !state.going_away {
								let (Some(runner_id), Some(runner_workflow_id), Some(runner_protocol_version)) =
									(state.runner_id, state.runner_workflow_id, state.runner_protocol_version)
								else {
									continue;
								};

								state.gc_timeout_ts = Some(
									util::timestamp::now()
										+ ctx.config().pegboard().actor_stop_threshold(),
								);
								state.going_away = true;

								ctx.activity(runtime::SetNotConnectableInput {
									actor_id: input.actor_id,
								})
								.await?;

								if protocol::is_mk2(runner_protocol_version) {
									ctx.activity(runtime::InsertAndSendCommandsInput {
										actor_id: input.actor_id,
										generation: state.generation,
										runner_id,
										commands: vec![protocol::mk2::Command::CommandStopActor],
									})
									.await?;
								} else {
									ctx.signal(crate::workflows::runner::Command {
										inner: protocol::Command::CommandStopActor(
											protocol::CommandStopActor {
												actor_id: input.actor_id.to_string(),
												generation: state.generation,
											},
										),
									})
									.to_workflow_id(runner_workflow_id)
									.send()
									.await?;
								}
							}
						}
						Main::Destroy(_) => {
							// If allocated, send stop actor command
							if let (Some(runner_id), Some(runner_workflow_id), Some(runner_protocol_version)) =
								(state.runner_id, state.runner_workflow_id, state.runner_protocol_version)
							{
								if protocol::is_mk2(runner_protocol_version) {
									ctx.activity(runtime::InsertAndSendCommandsInput {
										actor_id: input.actor_id,
										generation: state.generation,
										runner_id,
										commands: vec![protocol::mk2::Command::CommandStopActor],
									})
									.await?;
								} else {
									ctx.signal(crate::workflows::runner::Command {
										inner: protocol::Command::CommandStopActor(
											protocol::CommandStopActor {
												actor_id: input.actor_id.to_string(),
												generation: state.generation,
											},
										),
									})
									.to_workflow_id(runner_workflow_id)
									.send()
									.await?;
								}
							}

							return Ok(Loop::Break(state.result(false)));
						}
					}
				}

				Ok(Loop::Continue)
			}
			.boxed()
		})
		.await?;

	// At this point, the actor is not allocated so no cleanup related to alloc idx/desired slots needs to be
	// done.

	if let Some(metrics_workflow_id) = lifecycle_res.metrics_workflow_id {
		ctx.v(2)
			.signal(metrics::Destroy {
				ts: util::timestamp::now(),
			})
			.to_workflow_id(metrics_workflow_id)
			.send()
			.await?;
	}

	if lifecycle_res.migrate_to_v2 {
		ctx.workflow(crate::workflows::actor2::Input {
			actor_id: input.actor_id,
			name: input.name.clone(),
			pool_name: input.runner_name_selector.clone(),
			key: input.key.clone(),
			namespace_id: input.namespace_id,
			input: input.input.clone(),
			from_v1: true,
			lane_hint: input.lane_hint.clone(),
		})
		.tag("actor_id", input.actor_id)
		.dispatch()
		.await?;

		ctx.msg(MigratedToV2 {})
			.topic(("actor_id", input.actor_id))
			.send()
			.await?;
	} else {
		ctx.workflow(destroy::Input {
			namespace_id: input.namespace_id,
			actor_id: input.actor_id,
			name: input.name.clone(),
			key: input.key.clone(),
			generation: lifecycle_res.generation,
		})
		.output()
		.await?;
	}

	Ok(())
}

async fn handle_reserve_key_output(
	ctx: &mut WorkflowCtx,
	input: &Input,
	key: &str,
	reserve_res: keys::ReserveKeyOutput,
) -> Result<bool> {
	match reserve_res {
		keys::ReserveKeyOutput::Success => Ok(true),
		keys::ReserveKeyOutput::ForwardToDatacenter { dc_label } => {
			ctx.msg(Failed {
				error: errors::Actor::KeyReservedInDifferentDatacenter {
					datacenter_label: dc_label,
				},
			})
			.topic(("actor_id", input.actor_id))
			.send()
			.await?;

			ctx.workflow(destroy::Input {
				namespace_id: input.namespace_id,
				actor_id: input.actor_id,
				name: input.name.clone(),
				key: input.key.clone(),
				generation: 0,
			})
			.output()
			.await?;

			Ok(false)
		}
		keys::ReserveKeyOutput::KeyExists { existing_actor_id } => {
			ctx.msg(Failed {
				error: errors::Actor::DuplicateKey {
					key: key.to_owned(),
					existing_actor_id,
				},
			})
			.topic(("actor_id", input.actor_id))
			.send()
			.await?;

			ctx.workflow(destroy::Input {
				namespace_id: input.namespace_id,
				actor_id: input.actor_id,
				name: input.name.clone(),
				key: input.key.clone(),
				generation: 0,
			})
			.output()
			.await?;

			// TODO(RVT-3928): return Ok(Err);
			Ok(false)
		}
	}
}

#[derive(Deserialize, Serialize)]
pub struct State {
	pub name: String,
	pub key: Option<String>,

	pub namespace_id: Id,
	pub runner_name_selector: String,
	#[serde(default)]
	pub lane_hint: Option<String>,
	pub crash_policy: CrashPolicy,

	pub create_ts: i64,
	pub create_complete_ts: Option<i64>,

	// As opposed to allocated_serverless_slot, this is only set when allocating if the chosen runner has a
	// serverless config
	#[serde(default)]
	pub for_serverless: bool,
	// This is used for state management for incrementing/decrementing the serverless desired slots key
	#[serde(default)]
	pub allocated_serverless_slot: bool,

	pub start_ts: Option<i64>,
	// NOTE: This is not the alarm ts, this is when the actor started sleeping. See `LifecycleState` for alarm
	pub sleep_ts: Option<i64>,
	pub complete_ts: Option<i64>,
	pub connectable_ts: Option<i64>,
	pub pending_allocation_ts: Option<i64>,
	#[serde(default)]
	pub reschedule_ts: Option<i64>,
	pub destroy_ts: Option<i64>,

	// Null if not allocated
	pub runner_id: Option<Id>,
	pub runner_workflow_id: Option<Id>,
	pub runner_state: Option<RunnerState>,

	/// Explains why the actor is NOT healthy, either due to failure to allocate or a failed
	/// runner.
	///
	/// # When failure_reason is cleared
	///
	/// - When actor is allocated (gets a runner assigned)
	/// - When actor becomes connectable
	#[serde(default)]
	pub failure_reason: Option<FailureReason>,
}

impl State {
	pub fn new(
		name: String,
		key: Option<String>,
		namespace_id: Id,
		runner_name_selector: String,
		lane_hint: Option<String>,
		crash_policy: CrashPolicy,
		create_ts: i64,
	) -> Self {
		State {
			name,
			key,

			namespace_id,
			runner_name_selector,
			lane_hint,
			crash_policy,

			create_ts,
			create_complete_ts: None,

			for_serverless: false,
			allocated_serverless_slot: false,

			start_ts: None,
			pending_allocation_ts: None,
			sleep_ts: None,
			connectable_ts: None,
			complete_ts: None,
			reschedule_ts: None,
			destroy_ts: None,

			runner_id: None,
			runner_workflow_id: None,
			runner_state: None,

			failure_reason: None,
		}
	}

	pub fn worker_lane(&self) -> crate::executor::WorkerLane {
		crate::executor::worker_lane_from_hint(self.lane_hint.as_deref())
	}
}

/// Reason why an actor failed to allocate or run.
///
/// Distinct from `errors::Actor` which represents user-facing API errors.
#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
	/// Actor cannot allocate due to no available runner capacity. Only set if `failure_reason`
	/// is currently `None` (runner failures take precedence as root causes).
	NoCapacity,
	/// Runner did not respond with expected events (GC timeout).
	RunnerNoResponse { runner_id: Id },
	/// Runner connection was lost (no recent ping, network issue, or crash).
	RunnerConnectionLost { runner_id: Id },
	/// Runner was draining but actor didn't stop in time.
	RunnerDrainingTimeout { runner_id: Id },
	/// Actor crashed during execution.
	Crashed { message: Option<String> },
}

impl FailureReason {
	/// Used to determine the category of this error.
	///
	/// Actor errors will not override runner errors.
	pub fn is_runner_failure(&self) -> bool {
		match self {
			FailureReason::NoCapacity | FailureReason::Crashed { .. } => false,
			FailureReason::RunnerNoResponse { .. }
			| FailureReason::RunnerConnectionLost { .. }
			| FailureReason::RunnerDrainingTimeout { .. } => true,
		}
	}
}

#[derive(Deserialize, Serialize)]
pub struct RunnerState {
	pub last_command_idx: i64,
}

impl Default for RunnerState {
	fn default() -> Self {
		RunnerState {
			last_command_idx: -1,
		}
	}
}

enum ActorSignalTimeout {
	Lost,
	Wake,
	ResumeMetrics,
}

async fn listen_for_actor_signals(
	ctx: &mut WorkflowCtx,
	input: &Input,
	state: &mut runtime::LifecycleState,
) -> Result<Vec<Main>> {
	let timeout = [
		state.gc_timeout_ts.map(|ts| (ts, ActorSignalTimeout::Lost)),
		state.alarm_ts.map(|ts| (ts, ActorSignalTimeout::Wake)),
		state
			.metrics_resume_ts
			.map(|ts| (ts, ActorSignalTimeout::ResumeMetrics)),
	]
	.into_iter()
	.flatten()
	.min_by_key(|(ts, _)| *ts);

	if let Some((timeout_ts, timeout)) = timeout {
		let signals = ctx.listen_n_until::<Main>(timeout_ts, 256).await?;
		if !signals.is_empty() {
			return Ok(signals);
		}

		match timeout {
			ActorSignalTimeout::Lost => {
				tracing::warn!(actor_id=?input.actor_id, "actor lost");

				Ok(vec![Main::Lost(Lost {
					generation: state.generation,
					force_reschedule: false,
					reset_rescheduling: false,
					reason: Some(LostReason::RunnerNoResponse),
				})])
			}
			ActorSignalTimeout::Wake => {
				tracing::debug!(actor_id=?input.actor_id, "actor wake");

				Ok(vec![Main::Wake(Wake {
					allocation_override: AllocationOverride::DontSleep {
						pending_timeout: None,
					},
				})])
			}
			ActorSignalTimeout::ResumeMetrics => {
				let resume_ts = state
					.metrics_resume_start_ts
					.take()
					.unwrap_or_else(util::timestamp::now);
				state.metrics_resume_ts = None;
				resume_metrics_workflow(ctx, input, state, resume_ts).await?;

				Ok(Vec::new())
			}
		}
	} else {
		// Listen for signals normally.
		ctx.listen_n::<Main>(256).await
	}
}

async fn resume_or_schedule_metrics_workflow(
	ctx: &mut WorkflowCtx,
	input: &Input,
	state: &mut runtime::LifecycleState,
) -> Result<()> {
	let now = util::timestamp::now();
	if state.metrics_workflow_id.is_some() {
		resume_metrics_workflow(ctx, input, state, now).await?;
	} else if state.metrics_resume_ts.is_none() {
		state.metrics_resume_start_ts = Some(now);
		state.metrics_resume_ts = Some(now + INITIAL_METRICS_RESUME_DELAY_MS);
	}

	Ok(())
}

async fn resume_metrics_workflow(
	ctx: &mut WorkflowCtx,
	input: &Input,
	state: &mut runtime::LifecycleState,
	resume_ts: i64,
) -> Result<()> {
	let metrics_workflow_id = if let Some(metrics_workflow_id) = state.metrics_workflow_id {
		metrics_workflow_id
	} else {
		let metrics_dispatch_started = std::time::Instant::now();
		let metrics_workflow_id = ctx
			.v(2)
			.workflow(metrics::Input {
				actor_id: input.actor_id,
				namespace_id: input.namespace_id,
				name: input.name.clone(),
			})
			.tag("actor_id", input.actor_id)
			.dispatch()
			.await?;
		state.metrics_workflow_id = Some(metrics_workflow_id);

		let metrics_dispatch_duration_ms = metrics_dispatch_started.elapsed().as_millis();
		if metrics_dispatch_duration_ms >= 1000 {
			tracing::warn!(
				actor_id = ?input.actor_id,
				metrics_dispatch_duration_ms,
				"slow actor metrics workflow dispatch"
			);
		}

		metrics_workflow_id
	};

	ctx.v(2)
		.signal(metrics::Resume { ts: resume_ts })
		.to_workflow_id(metrics_workflow_id)
		.send()
		.await?;

	Ok(())
}

#[derive(Debug)]
enum StoppedVariant {
	Normal {
		code: protocol::mk2::StopCode,
		message: Option<String>,
	},
	Lost {
		force_reschedule: bool,
		failure_reason: Option<FailureReason>,
	},
}

enum StoppedResult {
	Continue,
	Destroy,
	MigrateToV2,
}

async fn handle_stopped(
	ctx: &mut WorkflowCtx,
	input: &Input,
	state: &mut runtime::LifecycleState,
	variant: StoppedVariant,
) -> Result<StoppedResult> {
	tracing::debug!(?variant, "actor stopped");

	let force_reschedule = match &variant {
		StoppedVariant::Normal {
			code: protocol::mk2::StopCode::Ok,
			..
		} => {
			// Reset retry count on successful exit
			state.reschedule_state = Default::default();

			false
		}
		StoppedVariant::Normal {
			code: protocol::mk2::StopCode::Error,
			message,
		} => {
			ctx.v(3)
				.activity(runtime::SetFailureReasonInput {
					failure_reason: FailureReason::Crashed {
						message: message.clone(),
					},
				})
				.await?;

			false
		}
		StoppedVariant::Lost {
			force_reschedule,
			failure_reason,
		} => {
			// Set runner failure reason if actor was lost unexpectedly.
			// This is set early (before crash policy handling) because it applies to all crash policies.
			if let Some(failure_reason) = &failure_reason {
				ctx.v(3)
					.activity(runtime::SetFailureReasonInput {
						failure_reason: failure_reason.clone(),
					})
					.await?;
			}

			*force_reschedule
		}
	};

	// Clear stop gc timeout to prevent being marked as lost in the lifecycle loop
	state.gc_timeout_ts = None;
	state.stopping = false;
	let old_runner_id = state.runner_id.take();
	let old_runner_workflow_id = state.runner_workflow_id.take();
	let old_runner_protocol_version = state.runner_protocol_version.take();
	state.runner_state = None;
	state.metrics_resume_ts = None;
	state.metrics_resume_start_ts = None;

	let deallocate_res = ctx
		.activity(runtime::DeallocateInput {
			actor_id: input.actor_id,
		})
		.await?;

	// Allocate other pending actors from queue since a slot has now cleared
	let allocate_pending_res = ctx
		.activity(AllocatePendingActorsInput {
			namespace_id: input.namespace_id,
			name: input.runner_name_selector.clone(),
		})
		.await?;

	// Pause periodic metrics workflow if it has started.
	if let Some(metrics_workflow_id) = state.metrics_workflow_id {
		ctx.v(3)
			.signal(metrics::Pause {
				ts: util::timestamp::now(),
			})
			.to_workflow_id(metrics_workflow_id)
			.send()
			.await?;
	}

	if allocate_pending_res.allocations.is_empty() {
		// Bump pool so it can scale down if needed
		if deallocate_res.for_serverless {
			ctx.removed::<Message<BumpServerlessAutoscalerStub>>()
				.await?;

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
		}
	} else {
		// Dispatch pending allocs (if any)
		for alloc in allocate_pending_res.allocations {
			ctx.signal(alloc.signal)
				.to_workflow::<Workflow>()
				.tag("actor_id", alloc.actor_id)
				.send()
				.await?;
		}
	}

	// We don't know the state of the previous generation of this actor actor if it becomes lost, send stop
	// command in case it ended up allocating
	if let (
		StoppedVariant::Lost { .. },
		Some(old_runner_id),
		Some(old_runner_workflow_id),
		Some(old_runner_protocol_version),
	) = (
		&variant,
		old_runner_id,
		old_runner_workflow_id,
		old_runner_protocol_version,
	) {
		if protocol::is_mk2(old_runner_protocol_version) {
			ctx.activity(runtime::InsertAndSendCommandsInput {
				actor_id: input.actor_id,
				generation: state.generation,
				runner_id: old_runner_id,
				commands: vec![protocol::mk2::Command::CommandStopActor],
			})
			.await?;
		} else {
			ctx.signal(crate::workflows::runner::Command {
				inner: protocol::Command::CommandStopActor(protocol::CommandStopActor {
					actor_id: input.actor_id.to_string(),
					generation: state.generation,
				}),
			})
			.to_workflow_id(old_runner_workflow_id)
			.send()
			.await?;
		}
	}

	// Reschedule no matter what
	if force_reschedule {
		match runtime::reschedule_actor(
			ctx,
			&input,
			state,
			AllocationOverride::DontSleep {
				pending_timeout: None,
			},
		)
		.await?
		{
			runtime::SpawnActorOutput::Allocated { .. } => {}
			// NOTE: This should be unreachable because force_reschedule is true
			runtime::SpawnActorOutput::Sleep => {
				state.sleeping = true;

				ctx.activity(runtime::SetSleepingInput {
					actor_id: input.actor_id,
				})
				.await?;
			}
			// Destroyed early
			runtime::SpawnActorOutput::Destroy => return Ok(StoppedResult::Destroy),
			runtime::SpawnActorOutput::MigrateToV2 => return Ok(StoppedResult::MigrateToV2),
		}
	}
	// Handle rescheduling if not marked as sleeping
	else if !state.sleeping {
		let graceful_exit = !state.going_away
			&& matches!(
				variant,
				StoppedVariant::Normal {
					code: protocol::mk2::StopCode::Ok,
					..
				}
			);

		match (input.crash_policy, graceful_exit) {
			(CrashPolicy::Restart, false) => {
				match runtime::reschedule_actor(
					ctx,
					&input,
					state,
					AllocationOverride::PendingTimeout {
						pending_timeout: RESTART_PENDING_TIMEOUT_MS,
					},
				)
				.await?
				{
					runtime::SpawnActorOutput::Allocated { .. } => {}
					runtime::SpawnActorOutput::Sleep => {
						tracing::debug!(actor_id=?input.actor_id, "actor sleeping due to failure to allocate");

						state.sleeping = true;

						ctx.v(2)
							.activity(runtime::SetSleepingInput {
								actor_id: input.actor_id,
							})
							.await?;
					}
					runtime::SpawnActorOutput::Destroy => {
						// Destroyed early
						return Ok(StoppedResult::Destroy);
					}
					runtime::SpawnActorOutput::MigrateToV2 => {
						return Ok(StoppedResult::MigrateToV2);
					}
				}
			}
			(CrashPolicy::Sleep, false) => {
				tracing::debug!(actor_id=?input.actor_id, "actor sleeping due to ungraceful exit");

				state.sleeping = true;

				ctx.removed::<Activity<runtime::SetFailureReason>>().await?;

				ctx.activity(runtime::SetSleepingInput {
					actor_id: input.actor_id,
				})
				.await?;
			}
			_ => {
				ctx.activity(runtime::SetCompleteInput {}).await?;

				return Ok(StoppedResult::Destroy);
			}
		}
	}
	// Rewake actor immediately after stopping if `will_wake` was set
	else if state.will_wake {
		state.sleeping = false;

		match runtime::reschedule_actor(ctx, &input, state, AllocationOverride::None).await? {
			runtime::SpawnActorOutput::Allocated { .. } => {}
			runtime::SpawnActorOutput::Sleep => {
				state.sleeping = true;
			}
			// Destroyed early
			runtime::SpawnActorOutput::Destroy => return Ok(StoppedResult::Destroy),
			runtime::SpawnActorOutput::MigrateToV2 => return Ok(StoppedResult::MigrateToV2),
		}
	}

	state.will_wake = false;
	state.going_away = false;

	ctx.msg(Stopped {})
		.topic(("actor_id", input.actor_id))
		.send()
		.await?;

	ctx.removed::<Activity<runtime::CheckRunnersStub>>().await?;

	Ok(StoppedResult::Continue)
}

// v6 histories used the split setup path; keep them replay-compatible.
fn use_combined_keyed_create_version(version: usize) -> bool {
	version == 5 || version >= 7
}

// v8 keeps keyed setup in one activity but fuses the fresh-path UDB writes into
// one transaction. Older versions preserve the prior two-transaction activity
// for replay compatibility.
fn use_fused_keyed_create_version(version: usize) -> bool {
	version >= 8
}

#[cfg(test)]
mod tests {
	use super::{use_combined_keyed_create_version, use_fused_keyed_create_version};

	#[test]
	fn combined_keyed_create_version_keeps_v6_replay_split() {
		assert!(!use_combined_keyed_create_version(4));
		assert!(use_combined_keyed_create_version(5));
		assert!(!use_combined_keyed_create_version(6));
		assert!(use_combined_keyed_create_version(7));
		assert!(use_combined_keyed_create_version(8));
	}

	#[test]
	fn fused_keyed_create_starts_at_v8() {
		assert!(!use_fused_keyed_create_version(7));
		assert!(use_fused_keyed_create_version(8));
		assert!(use_fused_keyed_create_version(9));
	}
}

#[derive(Debug, Serialize, Deserialize, Hash)]
struct GetTsInput {}

#[activity(GetTs)]
async fn get_ts(ctx: &ActivityCtx, input: &GetTsInput) -> Result<i64> {
	Ok(util::timestamp::now())
}

#[message("pegboard_actor_create_complete")]
pub struct CreateComplete {
	#[serde(default)]
	pub actor: Option<Actor>,
}

#[message("pegboard_actor_failed")]
pub struct Failed {
	pub error: errors::Actor,
}

#[message("pegboard_actor_ready")]
pub struct Ready {
	pub runner_id: Id,
}

#[message("pegboard_actor_stopped")]
pub struct Stopped {}

#[signal("pegboard_actor_allocate")]
#[derive(Debug)]
pub struct Allocate {
	pub runner_id: Id,
	pub runner_workflow_id: Id,
	#[serde(default)]
	pub runner_protocol_version: Option<u16>,
}

#[derive(Debug)]
#[signal("pegboard_actor_event")]
pub struct Event {
	pub inner: protocol::Event,
}

#[derive(Debug)]
#[signal("pegboard_actor_events")]
pub struct Events {
	pub runner_id: Id,
	pub events: Vec<protocol::mk2::EventWrapper>,
}

#[signal("pegboard_actor_wake")]
pub struct Wake {
	#[serde(default)]
	pub allocation_override: AllocationOverride,
}

/// Reason why an actor was lost.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LostReason {
	/// Runner did not respond with expected events (GC timeout).
	RunnerNoResponse,
	/// Runner is gracefully draining.
	RunnerDraining,
	/// Runner connection was lost (no recent ping, network issue, or crash).
	RunnerConnectionLost,
	/// Runner was draining but actor didn't stop in time.
	RunnerDrainingTimeout,
}

#[derive(Debug)]
#[signal("pegboard_actor_lost")]
pub struct Lost {
	pub generation: u32,
	/// Immediately reschedules the actor regardless of its crash policy.
	pub force_reschedule: bool,
	/// Resets the rescheduling retry count to 0.
	#[serde(default)]
	pub reset_rescheduling: bool,
	/// Why the actor was lost. If not provided, no failure reason is set
	/// (legacy signals before this field was added).
	#[serde(default)]
	pub reason: Option<LostReason>,
}

#[derive(Debug)]
#[signal("pegboard_actor_going_away")]
pub struct GoingAway {
	pub generation: u32,
	/// Resets the rescheduling retry count to 0.
	#[serde(default)]
	pub reset_rescheduling: bool,
}

#[message("pegboard_actor_migrated_to_v2")]
pub struct MigratedToV2 {}

#[signal("pegboard_actor_destroy")]
pub struct Destroy {}

#[message("pegboard_actor_destroy_started")]
pub struct DestroyStarted {}

#[message("pegboard_actor_destroy_complete")]
pub struct DestroyComplete {}

join_signal!(PendingAllocation {
	Allocate,
	Destroy,
	// Comment to prevent invalid formatting
});

join_signal!(Main {
	Event,
	Events,
	Wake,
	Lost,
	GoingAway,
	Destroy,
	// Comment to prevent invalid formatting
});

#[message("pegboard_bump_serverless_autoscaler")]
pub(crate) struct BumpServerlessAutoscalerStub {}
