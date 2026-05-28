use anyhow::Result;
use gas::prelude::*;
use rivet_envoy_protocol::{self as protocol, PROTOCOL_VERSION, versioned};
use rivet_guard_core::errors::WebSocketServiceTimeout;
use scc::{HashMap, hash_map::Entry};
use std::{
	collections::VecDeque,
	ops::Deref,
	sync::{Arc, Mutex},
	time::{Duration, Instant},
};
use tokio::sync::{Mutex as TokioMutex, mpsc, watch};
use universalpubsub::{NextOutput, PubSub, PublishOpts};
use vbare::OwnedVersionedData;

use crate::{WebsocketPendingLimitReached, metrics};

const REQUEST_MESSAGE_CHANNEL_CAPACITY: usize = 128;

#[derive(Debug)]
pub enum MsgGcReason {
	/// Gateway channel is closed and is not hibernating
	GatewayClosed,
	/// WebSocket pending messages (ToRivetWebSocketMessageAck)
	WebSocketMessageNotAcked {
		#[allow(dead_code)]
		first_msg_index: u16,
		#[allow(dead_code)]
		last_msg_index: u16,
	},
	/// The gateway has not kept alive the in flight request during hibernation for the given timeout
	/// duration.
	HibernationTimeout,
}

pub struct SharedStateInner {
	ups: PubSub,
	gateway_id: protocol::GatewayId,
	receiver_subject: String,
	in_flight_requests: HashMap<protocol::RequestId, InFlightRequest>,
	hibernation_timeout: i64,
	// Config values
	gc_interval: Duration,
	tunnel_ping_timeout: i64,
	hws_message_ack_timeout: Duration,
	hws_max_pending_size: u64,
}

#[derive(Clone)]
pub struct SharedState(Arc<SharedStateInner>);

impl SharedState {
	pub fn new(config: &rivet_config::Config, ups: PubSub) -> Self {
		let gateway_id = protocol::util::generate_gateway_id();
		tracing::info!(gateway_id = %protocol::util::id_to_string(&gateway_id), "setting up shared state for gateway");
		let receiver_subject =
			pegboard::pubsub_subjects::GatewayReceiverSubject::new(gateway_id).to_string();

		let pegboard_config = config.pegboard();
		Self(Arc::new(SharedStateInner {
			ups,
			gateway_id,
			receiver_subject,
			in_flight_requests: HashMap::new(),
			hibernation_timeout: pegboard_config.hibernating_request_eligible_threshold(),
			gc_interval: Duration::from_millis(pegboard_config.gateway_gc_interval_ms()),
			tunnel_ping_timeout: pegboard_config.gateway_tunnel_ping_timeout_ms(),
			hws_message_ack_timeout: Duration::from_millis(
				pegboard_config.gateway_hws_message_ack_timeout_ms(),
			),
			hws_max_pending_size: pegboard_config.gateway_hws_max_pending_size(),
		}))
	}

	pub fn gateway_id(&self) -> protocol::GatewayId {
		self.gateway_id
	}

	#[tracing::instrument(skip_all)]
	pub async fn start(&self) -> Result<()> {
		let self_clone = self.clone();
		tokio::spawn(async move { self_clone.receiver().await });

		let self_clone = self.clone();
		tokio::spawn(async move { self_clone.gc().await });

		Ok(())
	}

	#[tracing::instrument(skip_all)]
	async fn receiver(&self) {
		// Automatically resubscribe if unsubscribed
		loop {
			tracing::debug!(gateway_id=%protocol::util::id_to_string(&self.gateway_id), "subscribing to gateway receiver");
			let mut sub = match self.ups.subscribe(&self.receiver_subject).await {
				Ok(sub) => sub,
				Err(err) => {
					tracing::error!(
						?err,
						"failed to open gateway subscription, retrying in 2 seconds"
					);
					tokio::time::sleep(Duration::from_secs(2)).await;
					continue;
				}
			};

			loop {
				let msg = match sub.next().await {
					Ok(NextOutput::Message(msg)) => msg,
					Ok(NextOutput::Unsubscribed) => {
						tracing::error!(
							"gateway subscription unsubscribed, in flight messages may be lost"
						);
						break;
					}
					Err(err) => {
						tracing::error!(
							?err,
							"gateway subscription errored, in flight messages may be lost"
						);
						break;
					}
				};

				let msg =
					match versioned::ToGateway::deserialize_with_embedded_version(&msg.payload) {
						Ok(msg) => msg,
						Err(err) => {
							tracing::error!(?err, "failed to parse message");
							continue;
						}
					};

				let request_id = match &msg {
					protocol::ToGateway::ToGatewayPong(pong) => pong.request_id,
					protocol::ToGateway::ToRivetTunnelMessage(msg) => msg.message_id.request_id,
				};

				let Some(mut in_flight) = self.in_flight_requests.get_async(&request_id).await
				else {
					tracing::warn!(
						request_id=%protocol::util::id_to_string(&request_id),
						"in flight has already been disconnected, dropping message"
					);
					continue;
				};

				in_flight.recv_message(msg).await;
			}
		}
	}

	#[tracing::instrument(skip_all, fields(%receiver_subject, request_id=%protocol::util::id_to_string(&request_id)))]
	pub async fn create_or_wake_in_flight_request(
		&self,
		receiver_subject: String,
		request_id: protocol::RequestId,
		after_hibernation: bool,
	) -> Result<InFlightRequestCtx> {
		let (msg_tx, msg_rx) = tunnel_message_channel(
			REQUEST_MESSAGE_CHANNEL_CAPACITY,
			RequestPressurePublisher::new(
				self.ups.clone(),
				receiver_subject.clone(),
				self.gateway_id,
				request_id,
			),
		);
		let (drop_tx, drop_rx) = watch::channel(None);

		let new = match self.in_flight_requests.entry_async(request_id).await {
			Entry::Vacant(entry) => {
				entry.insert_entry(InFlightRequest {
					receiver_subject,
					message_index: 0,
					state: InFlightRequestState::Active {
						msg_tx,
						drop_tx,
						last_pong: util::timestamp::now(),
						hibernation_state: None,
					},
				});

				true
			}
			// If the entry already exists it means we transition from hibernating to active
			Entry::Occupied(mut entry) => {
				entry.wake(receiver_subject, msg_tx, drop_tx).await;

				false
			}
		};

		ensure!(
			!after_hibernation || !new,
			"should not be creating a new in flight entry after hibernation"
		);

		Ok(InFlightRequestCtx {
			msg_rx,
			drop_rx,
			handle: InFlightRequestHandle {
				shared_state: self.clone(),
				request_id,
			},
		})
	}

	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&request_id)))]
	pub async fn get_hibernating_in_flight_request(
		&self,
		request_id: protocol::RequestId,
	) -> Result<InFlightRequestCtx> {
		let mut req = self
			.in_flight_requests
			.get_async(&request_id)
			.await
			.context("request not in flight")?;

		let (msg_tx, msg_rx) = tunnel_message_channel(
			REQUEST_MESSAGE_CHANNEL_CAPACITY,
			RequestPressurePublisher::new(
				self.ups.clone(),
				req.receiver_subject.clone(),
				self.gateway_id,
				request_id,
			),
		);
		let (drop_tx, drop_rx) = watch::channel(None);

		req.hibernate(msg_tx, drop_tx).await;

		Ok(InFlightRequestCtx {
			msg_rx,
			drop_rx,
			handle: InFlightRequestHandle {
				shared_state: self.clone(),
				request_id,
			},
		})
	}

	#[tracing::instrument(skip_all)]
	async fn gc(&self) {
		let mut interval = tokio::time::interval(self.gc_interval);
		interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

		loop {
			interval.tick().await;

			self.gc_in_flight_requests().await;
		}
	}

	#[tracing::instrument(skip_all)]
	async fn gc_in_flight_requests(&self) {
		let now = Instant::now();
		let hibernation_timeout =
			Duration::from_millis(self.hibernation_timeout.try_into().unwrap_or(90_000));

		self.in_flight_requests
			.retain_async(|request_id, req| {
				if let Some(reason) =
					req.expired(&self.hws_message_ack_timeout, &now, &hibernation_timeout)
				{
					tracing::debug!(
						request_id=%protocol::util::id_to_string(&request_id),
						?reason,
						"gc removing in flight request"
					);

					match &req.state {
						InFlightRequestState::Active { drop_tx, .. } => {
							if drop_tx.send(Some(reason)).is_err() {
								tracing::debug!(
									request_id=%protocol::util::id_to_string(&request_id),
									"failed to send gc reason msg to gateway",
								);
							}
						}
						InFlightRequestState::PendingHibernation { .. } => {}
						InFlightRequestState::Hibernating { drop_tx, .. } => {
							if drop_tx.send(Some(reason)).is_err() {
								tracing::debug!(
									request_id=%protocol::util::id_to_string(&request_id),
									"failed to send gc reason msg to gateway",
								);
							}
						}
					}

					false
				} else {
					true
				}
			})
			.await;
	}
}

impl Deref for SharedState {
	type Target = SharedStateInner;

	fn deref(&self) -> &Self::Target {
		&self.0
	}
}

pub struct InFlightRequestCtx {
	pub msg_rx: TunnelMessageReceiver,
	/// Used to check if the request handler has been dropped.
	///
	/// This is separate from `msg_rx` there may still be messages that need to be sent to the
	/// request after `msg_rx` has dropped.
	pub drop_rx: watch::Receiver<Option<MsgGcReason>>,
	pub handle: InFlightRequestHandle,
}

#[derive(Clone)]
pub struct InFlightRequestHandle {
	shared_state: SharedState,
	pub request_id: protocol::RequestId,
}

impl InFlightRequestHandle {
	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&self.request_id)))]
	pub async fn send_message(
		&self,
		message_kind: protocol::ToEnvoyTunnelMessageKind,
	) -> Result<()> {
		let mut req = self
			.shared_state
			.in_flight_requests
			.get_async(&self.request_id)
			.await
			.context("request not in flight")?;

		// Generate message ID
		let message_id = protocol::MessageId {
			gateway_id: self.shared_state.gateway_id,
			request_id: self.request_id,
			message_index: req.message_index,
		};

		// Increment message index for next message
		let current_message_index = req.message_index;
		req.message_index = req.message_index.wrapping_add(1);

		// Check if this is a WebSocket message for hibernation tracking
		let is_ws_message = matches!(
			message_kind,
			protocol::ToEnvoyTunnelMessageKind::ToEnvoyWebSocketMessage(_)
		);

		let payload = protocol::ToEnvoyTunnelMessage {
			message_id,
			message_kind,
		};

		let message = protocol::ToEnvoyConn::ToEnvoyTunnelMessage(payload);
		let message_serialized = versioned::ToEnvoyConn::wrap_latest(message)
			.serialize_with_embedded_version(PROTOCOL_VERSION)?;

		if let (Some(hs), true) = (req.hibernation_state_mut(), is_ws_message) {
			hs.total_pending_ws_msgs_size += message_serialized.len() as u64;

			if hs.total_pending_ws_msgs_size > self.shared_state.hws_max_pending_size
				|| hs.pending_ws_msgs.len() >= u16::MAX as usize
			{
				return Err(WebsocketPendingLimitReached {}.build());
			}

			let pending_ws_msg = PendingWebsocketMessage {
				payload: message_serialized.clone(),
				send_instant: Instant::now(),
				message_index: current_message_index,
			};

			hs.pending_ws_msgs.push(pending_ws_msg);
			tracing::debug!(
				index = current_message_index,
				new_count = hs.pending_ws_msgs.len(),
				"pushed pending websocket message"
			);
		}

		self.shared_state
			.ups
			.publish(
				&req.receiver_subject,
				&message_serialized,
				PublishOpts::one(),
			)
			.await?;

		Ok(())
	}

	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&self.request_id)))]
	pub async fn send_and_check_ping(&self) -> Result<()> {
		let req = self
			.shared_state
			.in_flight_requests
			.get_async(&self.request_id)
			.await
			.context("request not in flight")?;

		let last_pong = match &req.state {
			InFlightRequestState::Active { last_pong, .. } => last_pong,
			InFlightRequestState::PendingHibernation { .. }
			| InFlightRequestState::Hibernating { .. } => {
				bail!("cannot check ping on hibernating req")
			}
		};

		let now = util::timestamp::now();

		// Verify ping timeout
		if now.saturating_sub(*last_pong) > self.shared_state.tunnel_ping_timeout {
			tracing::warn!(envoy_topic=%req.receiver_subject, "tunnel timeout");
			return Err(WebSocketServiceTimeout.build());
		}

		let message = protocol::ToEnvoyConn::ToEnvoyConnPing(protocol::ToEnvoyConnPing {
			gateway_id: self.shared_state.gateway_id,
			request_id: self.request_id,
			ts: now,
		});
		let message_serialized = versioned::ToEnvoyConn::wrap_latest(message)
			.serialize_with_embedded_version(PROTOCOL_VERSION)?;

		self.shared_state
			.ups
			.publish(
				&req.receiver_subject,
				&message_serialized,
				PublishOpts::one(),
			)
			.await?;

		Ok(())
	}

	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&self.request_id)))]
	pub async fn keepalive_hws(&self) -> Result<()> {
		let mut req = self
			.shared_state
			.in_flight_requests
			.get_async(&self.request_id)
			.await
			.context("request not in flight")?;

		if let Some(hs) = req.hibernation_state_mut() {
			hs.last_ping = Instant::now();
		} else {
			tracing::warn!("should not call keepalive_hws for non-hibernating ws");
		}

		Ok(())
	}
	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&self.request_id), %enable))]
	pub async fn toggle_hibernatable(&self, enable: bool) -> Result<()> {
		let mut req = self
			.shared_state
			.in_flight_requests
			.get_async(&self.request_id)
			.await
			.context("request not in flight")?;

		match &mut req.state {
			InFlightRequestState::Active {
				hibernation_state, ..
			} => match (hibernation_state.is_some(), enable) {
				(true, true) => {}
				(true, false) => *hibernation_state = None,
				(false, true) => {
					*hibernation_state = Some(HibernationState {
						total_pending_ws_msgs_size: 0,
						pending_ws_msgs: Vec::new(),
						pending_tunnel_msgs: Vec::new(),
						last_ping: Instant::now(),
					});
				}
				(false, false) => {}
			},
			InFlightRequestState::PendingHibernation { .. }
			| InFlightRequestState::Hibernating { .. } => {
				tracing::warn!("cannot toggle hibernation on hibernating request");
			}
		}

		Ok(())
	}

	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&self.request_id)))]
	pub async fn resend_pending_websocket_messages(&self) -> Result<()> {
		let Some(mut req) = self
			.shared_state
			.in_flight_requests
			.get_async(&self.request_id)
			.await
		else {
			bail!("request not in flight");
		};

		let receiver_subject = req.receiver_subject.clone();

		if let Some(hs) = req.hibernation_state_mut() {
			if !hs.pending_ws_msgs.is_empty() {
				tracing::debug!(len=?hs.pending_ws_msgs.len(), "resending pending messages");

				for pending_msg in &hs.pending_ws_msgs {
					self.shared_state
						.ups
						.publish(&receiver_subject, &pending_msg.payload, PublishOpts::one())
						.await?;
				}
			}
		}

		Ok(())
	}

	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&self.request_id)))]
	pub async fn has_pending_websocket_messages(&self) -> Result<bool> {
		let Some(req) = self
			.shared_state
			.in_flight_requests
			.get_async(&self.request_id)
			.await
		else {
			bail!("request not in flight");
		};

		match &req.state {
			InFlightRequestState::Active {
				hibernation_state: Some(hibernation_state),
				..
			}
			| InFlightRequestState::PendingHibernation { hibernation_state }
			| InFlightRequestState::Hibernating {
				hibernation_state, ..
			} => Ok(!hibernation_state.pending_ws_msgs.is_empty()),
			_ => Ok(false),
		}
	}

	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&self.request_id), %ack_index))]
	pub async fn ack_pending_websocket_messages(&self, ack_index: u16) -> Result<()> {
		let Some(mut req) = self
			.shared_state
			.in_flight_requests
			.get_async(&self.request_id)
			.await
		else {
			bail!("request not in flight");
		};

		let Some(hs) = req.hibernation_state_mut() else {
			tracing::warn!("cannot ack ws messages, hibernation is not enabled");
			return Ok(());
		};

		// Retain messages with index > ack_index (messages that haven't been acknowledged yet)
		let len_before = hs.pending_ws_msgs.len();
		hs.pending_ws_msgs
			.retain(|msg| wrapping_gt(msg.message_index, ack_index));

		let len_after = hs.pending_ws_msgs.len();
		tracing::debug!(
			removed_count = len_before - len_after,
			remaining_count = len_after,
			"acked pending websocket messages"
		);

		Ok(())
	}

	#[tracing::instrument(skip_all)]
	pub async fn start_hibernation(&self) -> Result<()> {
		let Some(mut req) = self
			.shared_state
			.in_flight_requests
			.get_async(&self.request_id)
			.await
		else {
			bail!("request not in flight");
		};

		match &mut req.state {
			InFlightRequestState::Active {
				hibernation_state, ..
			} => {
				req.state = InFlightRequestState::PendingHibernation {
					hibernation_state: std::mem::take(hibernation_state)
						.context("should be hibernatable")?,
				};
			}
			InFlightRequestState::PendingHibernation { .. } => {
				tracing::warn!("request already hibernating");
			}
			InFlightRequestState::Hibernating { .. } => {
				tracing::warn!("request already hibernating");
			}
		}

		Ok(())
	}

	#[tracing::instrument(skip_all)]
	pub async fn stop(&self) {
		self.shared_state
			.in_flight_requests
			.remove_async(&self.request_id)
			.await;
	}
}

pub struct TunnelMessageReceiver {
	rx: mpsc::Receiver<QueuedTunnelMessage>,
	queue: TunnelMessageQueue,
	pressure_publisher: RequestPressurePublisher,
}

impl TunnelMessageReceiver {
	pub async fn recv(&mut self) -> Option<protocol::ToRivetTunnelMessageKind> {
		let msg = self.rx.recv().await?;
		let was_full = self.queue.is_full();
		self.queue.record_dequeue();

		if was_full {
			self.pressure_publisher
				.publish_if_changed(self.queue.pressure())
				.await;
		}

		Some(msg.message_kind)
	}

	#[cfg(test)]
	pub fn try_recv(
		&mut self,
	) -> Result<protocol::ToRivetTunnelMessageKind, mpsc::error::TryRecvError> {
		self.rx.try_recv().map(|msg| {
			self.queue.record_dequeue();
			msg.message_kind
		})
	}
}

impl Drop for TunnelMessageReceiver {
	fn drop(&mut self) {
		self.queue.clear();
	}
}

struct TunnelMessageSender {
	tx: mpsc::Sender<QueuedTunnelMessage>,
	queue: TunnelMessageQueue,
	pressure_publisher: RequestPressurePublisher,
}

impl TunnelMessageSender {
	async fn send(
		&self,
		message_kind: protocol::ToRivetTunnelMessageKind,
	) -> Result<(), mpsc::error::SendError<protocol::ToRivetTunnelMessageKind>> {
		let permit = match self.tx.reserve().await {
			Ok(permit) => permit,
			Err(_) => return Err(mpsc::error::SendError(message_kind)),
		};
		self.queue.record_enqueue(Instant::now());
		permit.send(QueuedTunnelMessage { message_kind });

		Ok(())
	}

	fn is_closed(&self) -> bool {
		self.tx.is_closed()
	}

	fn is_full(&self) -> bool {
		self.queue.is_full()
	}

	async fn publish_pressure_if_changed(&self) {
		self.pressure_publisher
			.publish_if_changed(self.queue.pressure())
			.await;
	}
}

struct QueuedTunnelMessage {
	message_kind: protocol::ToRivetTunnelMessageKind,
}

#[derive(Clone)]
struct RequestPressurePublisher {
	ups: PubSub,
	receiver_subject: String,
	gateway_id: protocol::GatewayId,
	request_id: protocol::RequestId,
	last_pressure: Arc<TokioMutex<Option<protocol::Pressure>>>,
}

impl RequestPressurePublisher {
	fn new(
		ups: PubSub,
		receiver_subject: String,
		gateway_id: protocol::GatewayId,
		request_id: protocol::RequestId,
	) -> Self {
		Self {
			ups,
			receiver_subject,
			gateway_id,
			request_id,
			last_pressure: Arc::new(TokioMutex::new(None)),
		}
	}

	async fn publish_if_changed(&self, pressure: protocol::Pressure) {
		let mut last_pressure = self.last_pressure.lock().await;
		if last_pressure.as_ref() == Some(&pressure) {
			return;
		}

		let message =
			protocol::ToEnvoyConn::ToEnvoyTunnelPressure(protocol::ToEnvoyTunnelPressure {
				gateway_id: self.gateway_id,
				request_id: Some(self.request_id),
				pressure: pressure.clone(),
			});
		let message_serialized = match versioned::ToEnvoyConn::wrap_latest(message)
			.serialize_with_embedded_version(PROTOCOL_VERSION)
		{
			Ok(message) => message,
			Err(err) => {
				tracing::warn!(?err, "failed to serialize tunnel pressure message");
				return;
			}
		};

		if let Err(err) = self
			.ups
			.publish(
				&self.receiver_subject,
				&message_serialized,
				PublishOpts::one(),
			)
			.await
		{
			tracing::warn!(
				?err,
				receiver_subject = %self.receiver_subject,
				"failed to publish tunnel pressure message"
			);
			return;
		}

		*last_pressure = Some(pressure);
	}
}

#[derive(Clone)]
struct TunnelMessageQueue {
	inner: Arc<Mutex<TunnelMessageQueueState>>,
	capacity: usize,
}

impl TunnelMessageQueue {
	fn new(capacity: usize) -> Self {
		Self {
			inner: Arc::new(Mutex::new(TunnelMessageQueueState {
				enqueued_at: VecDeque::with_capacity(capacity),
			})),
			capacity,
		}
	}

	fn len(&self) -> usize {
		self.inner.lock().unwrap().enqueued_at.len()
	}

	fn is_full(&self) -> bool {
		self.len() >= self.capacity
	}

	fn record_enqueue(&self, enqueued_at: Instant) {
		self.inner
			.lock()
			.unwrap()
			.enqueued_at
			.push_back(enqueued_at);
	}

	fn record_dequeue(&self) {
		self.inner.lock().unwrap().enqueued_at.pop_front();
	}

	fn clear(&self) {
		self.inner.lock().unwrap().enqueued_at.clear();
	}

	fn pressure(&self) -> protocol::Pressure {
		let enqueued_at = self.inner.lock().unwrap();
		let queue_depth = enqueued_at.enqueued_at.len();
		let oldest_age_ms = enqueued_at
			.enqueued_at
			.front()
			.map(|ts| u64::try_from(ts.elapsed().as_millis()).unwrap_or(u64::MAX));

		protocol::Pressure {
			credit: self
				.capacity
				.saturating_sub(queue_depth)
				.min(u32::MAX as usize) as u32,
			queue_depth: queue_depth.min(u32::MAX as usize) as u32,
			oldest_age_ms,
		}
	}
}

struct TunnelMessageQueueState {
	enqueued_at: VecDeque<Instant>,
}

fn tunnel_message_channel(
	capacity: usize,
	pressure_publisher: RequestPressurePublisher,
) -> (TunnelMessageSender, TunnelMessageReceiver) {
	let (tx, rx) = mpsc::channel(capacity);
	let queue = TunnelMessageQueue::new(capacity);

	(
		TunnelMessageSender {
			tx,
			queue: queue.clone(),
			pressure_publisher: pressure_publisher.clone(),
		},
		TunnelMessageReceiver {
			rx,
			queue,
			pressure_publisher,
		},
	)
}

struct InFlightRequest {
	/// UPS subject to send messages to for this request.
	receiver_subject: String,
	/// Message index counter for this request.
	message_index: protocol::MessageIndex,
	state: InFlightRequestState,
}

impl InFlightRequest {
	fn hibernation_state_mut(&mut self) -> Option<&mut HibernationState> {
		match &mut self.state {
			InFlightRequestState::Active {
				hibernation_state, ..
			} => hibernation_state.as_mut(),
			InFlightRequestState::PendingHibernation { hibernation_state } => {
				Some(hibernation_state)
			}
			InFlightRequestState::Hibernating {
				hibernation_state, ..
			} => Some(hibernation_state),
		}
	}

	#[tracing::instrument(skip_all)]
	async fn recv_message(&mut self, msg: protocol::ToGateway) {
		match msg {
			protocol::ToGateway::ToGatewayPong(pong) => {
				match &mut self.state {
					InFlightRequestState::Active { last_pong, .. } => {
						let now = util::timestamp::now();
						*last_pong = now;

						let rtt = now.saturating_sub(pong.ts);
						metrics::TUNNEL_PING_DURATION.observe(rtt as f64 * 0.001);
					}
					// Ignore pings during hibernation
					InFlightRequestState::PendingHibernation { .. }
					| InFlightRequestState::Hibernating { .. } => {}
				}
			}
			protocol::ToGateway::ToRivetTunnelMessage(msg) => match &mut self.state {
				InFlightRequestState::Active {
					msg_tx,
					hibernation_state,
					..
				} => {
					publish_saturated_request_pressure(msg_tx).await;

					let returned_msg =
						forward_tunnel_message(&self.receiver_subject, &msg_tx, msg).await;

					if let Some(returned_msg) = returned_msg {
						if let Some(hibernation_state) = hibernation_state {
							hibernation_state.pending_tunnel_msgs.push(returned_msg);
						}
					} else {
						publish_request_channel_pressure(msg_tx).await;
					}
				}
				InFlightRequestState::PendingHibernation { hibernation_state } => {
					hibernation_state.pending_tunnel_msgs.push(msg);
				}
				InFlightRequestState::Hibernating {
					msg_tx,
					hibernation_state,
					..
				} => {
					publish_saturated_request_pressure(msg_tx).await;

					let returned_msg =
						forward_tunnel_message(&self.receiver_subject, &msg_tx, msg).await;

					if let Some(returned_msg) = returned_msg {
						hibernation_state.pending_tunnel_msgs.push(returned_msg);
					} else {
						publish_request_channel_pressure(msg_tx).await;
					}
				}
			},
		}
	}

	/// Transition from hibernating to active
	#[tracing::instrument(skip_all, fields(%receiver_subject))]
	async fn wake(
		&mut self,
		receiver_subject: String,
		msg_tx: TunnelMessageSender,
		drop_tx: watch::Sender<Option<MsgGcReason>>,
	) {
		self.receiver_subject = receiver_subject;

		let mut pending_tunnel_msgs = Vec::new();

		// TODO: Kinda ugly but avoids clones and whatnot
		replace_with::replace_with_or_abort(&mut self.state, |state| match state {
			// Already active
			state @ InFlightRequestState::Active { .. } => {
				tracing::warn!("should not be waking already active in flight req");

				state
			}
			// Forward pending tunnel msgs if any
			InFlightRequestState::PendingHibernation {
				mut hibernation_state,
			}
			| InFlightRequestState::Hibernating {
				mut hibernation_state,
				..
			} => {
				pending_tunnel_msgs = std::mem::take(&mut hibernation_state.pending_tunnel_msgs);

				InFlightRequestState::Active {
					msg_tx,
					drop_tx,
					last_pong: util::timestamp::now(),
					hibernation_state: Some(hibernation_state),
				}
			}
		});

		// Should be active at this point
		if let InFlightRequestState::Active { msg_tx, .. } = &self.state {
			for msg in pending_tunnel_msgs {
				forward_tunnel_message(&self.receiver_subject, msg_tx, msg).await;
			}
		}
	}

	/// Transition from pending hibernation to hibernating
	#[tracing::instrument(skip_all)]
	async fn hibernate(
		&mut self,
		msg_tx: TunnelMessageSender,
		drop_tx: watch::Sender<Option<MsgGcReason>>,
	) {
		let mut pending_tunnel_msgs = Vec::new();

		// TODO: Kinda ugly but avoids clones and whatnot
		replace_with::replace_with_or_abort(&mut self.state, |state| match state {
			state @ InFlightRequestState::Active { .. } => {
				tracing::warn!(
					"should not be hibernating a request that isn't pending hibernation"
				);

				state
			}
			// Forward pending tunnel msgs
			InFlightRequestState::PendingHibernation {
				mut hibernation_state,
			} => {
				pending_tunnel_msgs = std::mem::take(&mut hibernation_state.pending_tunnel_msgs);

				InFlightRequestState::Hibernating {
					msg_tx,
					drop_tx,
					hibernation_state,
				}
			}
			state @ InFlightRequestState::Hibernating { .. } => {
				tracing::warn!("should not be hibernating already hibernating in flight req");

				state
			}
		});

		// Should be hibernating at this point
		if let InFlightRequestState::Hibernating { msg_tx, .. } = &self.state {
			for msg in pending_tunnel_msgs {
				forward_tunnel_message(&self.receiver_subject, msg_tx, msg).await;
			}
		}
	}

	fn expired(
		&self,
		hws_message_ack_timeout: &Duration,
		now: &Instant,
		hibernation_timeout: &Duration,
	) -> Option<MsgGcReason> {
		match &self.state {
			InFlightRequestState::Active {
				hibernation_state: Some(hibernation_state),
				..
			}
			| InFlightRequestState::PendingHibernation { hibernation_state }
			| InFlightRequestState::Hibernating {
				hibernation_state, ..
			} => {
				if let Some(earliest_pending_ws_msg) = hibernation_state.pending_ws_msgs.first() {
					if &now.duration_since(earliest_pending_ws_msg.send_instant)
						> hws_message_ack_timeout
					{
						return Some(MsgGcReason::WebSocketMessageNotAcked {
							first_msg_index: earliest_pending_ws_msg.message_index,
							last_msg_index: self.message_index,
						});
					}
				}

				let hs_elapsed = hibernation_state.last_ping.elapsed();
				tracing::debug!(
					hs_elapsed=%hs_elapsed.as_secs_f64(),
					timeout=%hibernation_timeout.as_secs_f64(),
					"checking hibernating state elapsed time"
				);

				if &hs_elapsed > hibernation_timeout {
					return Some(MsgGcReason::HibernationTimeout);
				}

				None
			}
			InFlightRequestState::Active { msg_tx, .. } => {
				if msg_tx.is_closed() {
					Some(MsgGcReason::GatewayClosed)
				} else {
					None
				}
			}
		}
	}
}

enum InFlightRequestState {
	Active {
		/// Sender for incoming messages to this request.
		msg_tx: TunnelMessageSender,
		/// Used to check if the request handler has been dropped.
		drop_tx: watch::Sender<Option<MsgGcReason>>,
		last_pong: i64,
		hibernation_state: Option<HibernationState>,
	},
	/// In between active request handling and hibernation handling.
	PendingHibernation { hibernation_state: HibernationState },
	Hibernating {
		/// Sender for incoming messages to this request.
		msg_tx: TunnelMessageSender,
		/// Used to check if the hibernation handler has been dropped.
		drop_tx: watch::Sender<Option<MsgGcReason>>,
		hibernation_state: HibernationState,
	},
}

struct HibernationState {
	total_pending_ws_msgs_size: u64,
	/// Messages from the client that haven't been ack'd yet
	pending_ws_msgs: Vec<PendingWebsocketMessage>,
	/// Messages from the envoy that need to be forwarded to the client but can't yet because its hibernating
	pending_tunnel_msgs: Vec<protocol::ToRivetTunnelMessage>,
	// Used to keep hibernating websockets from being GC'd
	last_ping: Instant,
}

pub struct PendingWebsocketMessage {
	payload: Vec<u8>,
	send_instant: Instant,
	message_index: protocol::MessageIndex,
}

async fn publish_saturated_request_pressure(msg_tx: &TunnelMessageSender) {
	if msg_tx.is_full() {
		msg_tx.publish_pressure_if_changed().await;
	}
}

async fn publish_request_channel_pressure(msg_tx: &TunnelMessageSender) {
	msg_tx.publish_pressure_if_changed().await;
}

/// Returns `Some` if the message was not sent.
#[tracing::instrument(skip_all)]
async fn forward_tunnel_message(
	receiver_subject: &str,
	msg_tx: &TunnelMessageSender,
	mut msg: protocol::ToRivetTunnelMessage,
) -> Option<protocol::ToRivetTunnelMessage> {
	// Send message to the request handler to emulate the real network action
	let inner_size = match &msg.message_kind {
		protocol::ToRivetTunnelMessageKind::ToRivetWebSocketMessage(ws_msg) => ws_msg.data.len(),
		_ => 0,
	};
	tracing::debug!(
		gateway_id=%protocol::util::id_to_string(&msg.message_id.gateway_id),
		request_id=%protocol::util::id_to_string(&msg.message_id.request_id),
		message_index=msg.message_id.message_index,
		inner_size,
		"forwarding message to request handler"
	);

	if let Err(send_err) = msg_tx.send(msg.message_kind).await {
		tracing::debug!(
			gateway_id=%protocol::util::id_to_string(&msg.message_id.gateway_id),
			request_id=%protocol::util::id_to_string(&msg.message_id.request_id),
			receiver_subject=%receiver_subject,
			"message handler channel closed, saving to pending msgs",
		);

		msg.message_kind = send_err.0;
		Some(msg)
	} else {
		None
	}
}

fn wrapping_gt(a: u16, b: u16) -> bool {
	a != b && a.wrapping_sub(b) < u16::MAX / 2
}

// fn wrapping_lt(a: u16, b: u16) -> bool {
//     b.wrapping_sub(a) < u16::MAX / 2
// }

#[cfg(test)]
mod tests {
	use super::{REQUEST_MESSAGE_CHANNEL_CAPACITY, SharedState};
	use rivet_envoy_protocol::{self as protocol, versioned};
	use std::{
		sync::Arc,
		time::{Duration, Instant},
	};
	use universalpubsub::{NextOutput, PubSub, Subscriber, driver::memory::MemoryDriver};
	use vbare::OwnedVersionedData;

	fn test_config() -> rivet_config::Config {
		rivet_config::Config::from_root(rivet_config::config::Root::default())
	}

	fn memory_pubsub(channel: &str) -> PubSub {
		PubSub::new(Arc::new(MemoryDriver::new(channel.to_string())))
	}

	fn to_gateway_ws_message(
		gateway_id: protocol::GatewayId,
		request_id: protocol::RequestId,
	) -> protocol::ToGateway {
		protocol::ToGateway::ToRivetTunnelMessage(protocol::ToRivetTunnelMessage {
			message_id: protocol::MessageId {
				gateway_id,
				request_id,
				message_index: 0,
			},
			message_kind: to_rivet_ws_message_kind(),
		})
	}

	fn to_rivet_ws_message_kind() -> protocol::ToRivetTunnelMessageKind {
		protocol::ToRivetTunnelMessageKind::ToRivetWebSocketMessage(
			protocol::ToRivetWebSocketMessage {
				data: b"frame".to_vec(),
				binary: true,
			},
		)
	}

	async fn next_pressure(sub: &mut Subscriber) -> protocol::ToEnvoyTunnelPressure {
		let msg = tokio::time::timeout(Duration::from_secs(1), sub.next())
			.await
			.unwrap()
			.unwrap();
		let NextOutput::Message(msg) = msg else {
			panic!("expected pubsub message");
		};
		let decoded = versioned::ToEnvoyConn::deserialize_with_embedded_version(&msg.payload)
			.expect("pressure payload should decode");
		let protocol::ToEnvoyConn::ToEnvoyTunnelPressure(pressure) = decoded else {
			panic!("expected tunnel pressure");
		};

		pressure
	}

	#[tokio::test]
	async fn recv_tunnel_message_publishes_request_pressure() {
		let pubsub = memory_pubsub("pegboard-gateway2-request-pressure");
		let state = SharedState::new(&test_config(), pubsub.clone());
		let receiver_subject = "envoy-pressure".to_string();
		let request_id = [1, 2, 3, 4];
		let mut sub = pubsub.subscribe(&receiver_subject).await.unwrap();
		let mut ctx = state
			.create_or_wake_in_flight_request(receiver_subject, request_id, false)
			.await
			.unwrap();

		{
			let mut req = state
				.in_flight_requests
				.get_async(&request_id)
				.await
				.expect("request should be in flight");
			req.recv_message(to_gateway_ws_message(state.gateway_id(), request_id))
				.await;
		}

		let pressure = next_pressure(&mut sub).await;
		assert_eq!(pressure.gateway_id, state.gateway_id());
		assert_eq!(pressure.request_id, Some(request_id));
		assert_eq!(pressure.pressure.queue_depth, 1);
		assert_eq!(
			pressure.pressure.credit,
			(REQUEST_MESSAGE_CHANNEL_CAPACITY - 1) as u32
		);
		assert!(pressure.pressure.oldest_age_ms.is_some());

		let delivered = ctx.msg_rx.try_recv().expect("message should be queued");
		assert!(matches!(
			delivered,
			protocol::ToRivetTunnelMessageKind::ToRivetWebSocketMessage(_)
		));
	}

	#[tokio::test]
	async fn tunnel_message_receiver_publishes_release_after_full_queue_drains() {
		let pubsub = memory_pubsub("pegboard-gateway2-pressure-release");
		let receiver_subject = "envoy-pressure-release".to_string();
		let gateway_id = [9, 8, 7, 6];
		let request_id = [5, 4, 3, 2];
		let mut sub = pubsub.subscribe(&receiver_subject).await.unwrap();
		let (sender, mut receiver) = super::tunnel_message_channel(
			2,
			super::RequestPressurePublisher::new(pubsub, receiver_subject, gateway_id, request_id),
		);

		sender.send(to_rivet_ws_message_kind()).await.unwrap();
		sender.publish_pressure_if_changed().await;
		sender.send(to_rivet_ws_message_kind()).await.unwrap();
		sender.publish_pressure_if_changed().await;

		let _initial = next_pressure(&mut sub).await;
		let saturated = next_pressure(&mut sub).await;
		assert_eq!(saturated.pressure.credit, 0);
		assert_eq!(saturated.pressure.queue_depth, 2);

		let delivered = receiver.recv().await.expect("message should be queued");
		assert!(matches!(
			delivered,
			protocol::ToRivetTunnelMessageKind::ToRivetWebSocketMessage(_)
		));

		let release = next_pressure(&mut sub).await;
		assert_eq!(release.gateway_id, gateway_id);
		assert_eq!(release.request_id, Some(request_id));
		assert_eq!(release.pressure.credit, 1);
		assert_eq!(release.pressure.queue_depth, 1);
		assert!(release.pressure.oldest_age_ms.is_some());
	}

	#[test]
	fn tunnel_message_queue_pressure_tracks_oldest_age_and_dequeue() {
		let queue = super::TunnelMessageQueue::new(4);
		queue.record_enqueue(Instant::now() - Duration::from_millis(25));
		queue.record_enqueue(Instant::now());

		let pressure = queue.pressure();
		assert_eq!(pressure.credit, 2);
		assert_eq!(pressure.queue_depth, 2);
		assert!(
			pressure
				.oldest_age_ms
				.expect("oldest age should be present")
				>= 25
		);

		queue.record_dequeue();
		queue.record_dequeue();

		let pressure = queue.pressure();
		assert_eq!(pressure.credit, 4);
		assert_eq!(pressure.queue_depth, 0);
		assert_eq!(pressure.oldest_age_ms, None);
	}
}
