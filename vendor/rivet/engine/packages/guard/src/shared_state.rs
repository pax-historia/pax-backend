use anyhow::Result;
use std::{ops::Deref, sync::Arc};
use tokio::sync::watch;
use universalpubsub::{NextOutput, PubSub};

#[derive(Clone)]
pub struct SharedState(Arc<SharedStateInner>);

impl SharedState {
	pub fn new(config: &rivet_config::Config, pubsub: PubSub) -> SharedState {
		let (routing_directory_updates, _) = watch::channel(0);

		SharedState(Arc::new(SharedStateInner {
			pegboard_gateway: pegboard_gateway::shared_state::SharedState::new(
				config,
				pubsub.clone(),
			),
			pegboard_gateway2: pegboard_gateway2::shared_state::SharedState::new(
				config,
				pubsub.clone(),
			),
			pubsub,
			routing_directory: pegboard::routing_directory::RoutingDirectory::new(),
			routing_directory_updates,
		}))
	}

	pub async fn start(&self) -> Result<()> {
		self.start_routing_directory_receiver();

		tokio::try_join!(
			self.pegboard_gateway.start(),
			self.pegboard_gateway2.start(),
		)?;

		Ok(())
	}

	fn start_routing_directory_receiver(&self) {
		let shared_state = self.clone();
		tokio::spawn(async move { shared_state.routing_directory_receiver().await });
	}

	async fn routing_directory_receiver(&self) {
		let subject = pegboard::pubsub_subjects::RoutingDirectorySubject.to_string();

		loop {
			tracing::debug!(%subject, "subscribing to routing directory deltas");
			let mut sub = match self.pubsub.subscribe(&subject).await {
				Ok(sub) => sub,
				Err(err) => {
					tracing::error!(
						?err,
						%subject,
						"failed to open routing directory subscription, retrying in 2 seconds"
					);
					tokio::time::sleep(std::time::Duration::from_secs(2)).await;
					continue;
				}
			};

			loop {
				let msg = match sub.next().await {
					Ok(NextOutput::Message(msg)) => msg,
					Ok(NextOutput::Unsubscribed) => {
						tracing::error!(
							%subject,
							"routing directory subscription unsubscribed"
						);
						break;
					}
					Err(err) => {
						tracing::error!(?err, %subject, "routing directory subscription errored");
						break;
					}
				};

				match apply_routing_directory_payload(&self.routing_directory, &msg.payload) {
					Ok(RoutingDirectoryApply::AppliedNotifyWaiters) => {
						self.routing_directory_updates
							.send_modify(|version| *version = version.wrapping_add(1));
					}
					Ok(RoutingDirectoryApply::AppliedNoNotify) => {}
					Ok(RoutingDirectoryApply::Ignored) => {
						tracing::debug!("ignored stale routing directory delta");
					}
					Err(err) => {
						tracing::warn!(?err, "failed to apply routing directory delta");
					}
				}
			}
		}
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RoutingDirectoryApply {
	AppliedNotifyWaiters,
	AppliedNoNotify,
	Ignored,
}

fn apply_routing_directory_payload(
	directory: &pegboard::routing_directory::RoutingDirectory,
	payload: &[u8],
) -> Result<RoutingDirectoryApply> {
	let delta = pegboard::routing_directory::RoutingDelta::from_payload(payload)?;
	let notify_waiters = !matches!(
		delta,
		pegboard::routing_directory::RoutingDelta::TargetHeartbeat { .. }
	);

	if !directory.apply_delta(delta) {
		return Ok(RoutingDirectoryApply::Ignored);
	}

	Ok(if notify_waiters {
		RoutingDirectoryApply::AppliedNotifyWaiters
	} else {
		RoutingDirectoryApply::AppliedNoNotify
	})
}

impl Deref for SharedState {
	type Target = SharedStateInner;

	fn deref(&self) -> &Self::Target {
		&self.0
	}
}

pub struct SharedStateInner {
	pub pegboard_gateway: pegboard_gateway::shared_state::SharedState,
	pub pegboard_gateway2: pegboard_gateway2::shared_state::SharedState,
	pubsub: PubSub,
	pub routing_directory: pegboard::routing_directory::RoutingDirectory,
	pub routing_directory_updates: watch::Sender<u64>,
}

#[cfg(test)]
mod tests {
	use std::{
		sync::Arc,
		time::{Duration, Instant},
	};

	use gas::prelude::Id;
	use pegboard::routing_directory::{
		RoutingDelta, RoutingDirectory, RoutingLookup, RoutingSnapshot, RoutingStatus,
		RoutingTarget, publish_delta,
	};
	use universalpubsub::{PubSub, driver::memory::MemoryDriver};

	use super::{RoutingDirectoryApply, SharedState, apply_routing_directory_payload};

	fn id(label: u16) -> Id {
		Id::new_v1(label)
	}

	fn test_config() -> rivet_config::Config {
		rivet_config::Config::from_root(rivet_config::config::Root::default())
	}

	fn memory_pubsub(channel: &str) -> PubSub {
		PubSub::new(Arc::new(MemoryDriver::new(channel.to_string())))
	}

	#[test]
	fn routing_directory_payload_applies_to_directory() {
		let directory = RoutingDirectory::new();
		let actor_id = id(40);
		let runner_id = id(41);
		let delta = RoutingDelta::Ready {
			actor_id,
			generation: 1,
			target: RoutingTarget::Runner { runner_id },
		};
		let payload = delta.to_payload().expect("serialize routing delta");

		assert_eq!(
			apply_routing_directory_payload(&directory, &payload).expect("apply delta"),
			RoutingDirectoryApply::AppliedNotifyWaiters
		);
		assert_eq!(
			directory.lookup(actor_id, Instant::now(), Duration::from_secs(30)),
			RoutingLookup::Ready(RoutingSnapshot {
				actor_id,
				generation: 1,
				status: RoutingStatus::Ready,
				target: Some(RoutingTarget::Runner { runner_id }),
			})
		);
	}

	#[test]
	fn target_heartbeat_applies_without_waking_ready_waiters() {
		let directory = RoutingDirectory::new();
		let target = RoutingTarget::Runner { runner_id: id(47) };
		let payload = RoutingDelta::TargetHeartbeat {
			target: target.clone(),
		}
		.to_payload()
		.expect("serialize routing heartbeat");

		assert_eq!(
			apply_routing_directory_payload(&directory, &payload).expect("apply heartbeat"),
			RoutingDirectoryApply::AppliedNoNotify
		);
	}

	#[tokio::test]
	async fn routing_directory_receiver_applies_ready_delta_within_local_bound() {
		let pubsub = memory_pubsub("guard-routing-directory-ready-delta");
		let shared_state = SharedState::new(&test_config(), pubsub.clone());
		shared_state.start_routing_directory_receiver();

		let warmup_actor_id = id(42);
		let warmup_target = RoutingTarget::Runner { runner_id: id(43) };
		let warmup_delta = RoutingDelta::Ready {
			actor_id: warmup_actor_id,
			generation: 1,
			target: warmup_target.clone(),
		};

		let warmup_start = Instant::now();
		loop {
			publish_delta(&pubsub, warmup_delta.clone())
				.await
				.expect("publish warmup routing delta");

			if matches!(
				shared_state.routing_directory.lookup(
					warmup_actor_id,
					Instant::now(),
					Duration::from_secs(30),
				),
				RoutingLookup::Ready(_)
			) {
				break;
			}

			assert!(
				warmup_start.elapsed() < Duration::from_millis(250),
				"routing directory receiver did not subscribe during warmup"
			);
			tokio::time::sleep(Duration::from_millis(1)).await;
		}

		let actor_id = id(44);
		let runner_id = id(45);
		let target = RoutingTarget::Runner { runner_id };
		let delta = RoutingDelta::Ready {
			actor_id,
			generation: 2,
			target: target.clone(),
		};

		let started_at = Instant::now();
		publish_delta(&pubsub, delta)
			.await
			.expect("publish measured routing delta");

		loop {
			match shared_state.routing_directory.lookup(
				actor_id,
				Instant::now(),
				Duration::from_secs(30),
			) {
				RoutingLookup::Ready(snapshot) => {
					assert_eq!(
						snapshot,
						RoutingSnapshot {
							actor_id,
							generation: 2,
							status: RoutingStatus::Ready,
							target: Some(target),
						}
					);
					assert!(
						started_at.elapsed() <= Duration::from_millis(5),
						"routing directory Ready delta reached guard in {:?}",
						started_at.elapsed()
					);
					break;
				}
				_ => {
					assert!(
						started_at.elapsed() <= Duration::from_millis(5),
						"routing directory Ready delta did not reach guard within 5 ms"
					);
					tokio::task::yield_now().await;
				}
			}
		}
	}
}
