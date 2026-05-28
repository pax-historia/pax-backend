use anyhow::Result;
use gas::prelude::*;
use rivet_guard_core::errors::WebSocketServiceTimeout;
use rivet_runner_protocol::{
	self as protocol, PROTOCOL_MK1_VERSION, PROTOCOL_MK2_VERSION, versioned,
};
use scc::{HashMap, hash_map::Entry};
use std::{
	collections::VecDeque,
	ops::Deref,
	sync::Arc,
	time::{Duration, Instant},
};
use tokio::sync::{Mutex, mpsc, watch};
use tunnel_fabric::runner_gateway::{self, GatewayToRunnerAdapter};
use universalpubsub::{NextOutput, PubSub, PublishOpts};
use vbare::OwnedVersionedData;

use crate::{WebsocketPendingLimitReached, metrics};

const HIBERNATION_RESUME_GAP_CLOSE_CODE: u16 = 1012;
const HIBERNATION_RESUME_GAP_REASON: &str = "ws.resume_gap";
const MAX_EARLY_WEBSOCKET_MESSAGES: usize = 256;

pub struct InFlightRequestHandle {
	pub msg_rx: mpsc::Receiver<protocol::mk2::ToServerTunnelMessageKind>,
	/// Used to check if the request handler has been dropped.
	///
	/// This is separate from `msg_rx` there may still be messages that need to be sent to the
	/// request after `msg_rx` has dropped.
	pub drop_rx: watch::Receiver<Option<MsgGcReason>>,
	pub new: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InFlightRequestState {
	AwaitingHttpResponseStart,
	AwaitingWebSocketOpen,
	ActiveWebSocket,
	Closed,
}

impl InFlightRequestState {
	fn accept_message(&mut self, message_kind: &protocol::mk2::ToServerTunnelMessageKind) -> bool {
		use protocol::mk2::ToServerTunnelMessageKind;

		match (self, message_kind) {
			(
				state @ InFlightRequestState::AwaitingHttpResponseStart,
				ToServerTunnelMessageKind::ToServerResponseStart(_)
				| ToServerTunnelMessageKind::ToServerResponseAbort,
			) => {
				*state = InFlightRequestState::Closed;
				true
			}
			(
				state @ InFlightRequestState::AwaitingWebSocketOpen,
				ToServerTunnelMessageKind::ToServerWebSocketOpen(_),
			) => {
				*state = InFlightRequestState::ActiveWebSocket;
				true
			}
			(
				state @ InFlightRequestState::AwaitingWebSocketOpen,
				ToServerTunnelMessageKind::ToServerWebSocketClose(_),
			)
			| (
				state @ InFlightRequestState::ActiveWebSocket,
				ToServerTunnelMessageKind::ToServerWebSocketClose(_),
			) => {
				*state = InFlightRequestState::Closed;
				true
			}
			(
				InFlightRequestState::ActiveWebSocket,
				ToServerTunnelMessageKind::ToServerWebSocketMessage(_)
				| ToServerTunnelMessageKind::ToServerWebSocketMessageAck(_),
			) => true,
			_ => false,
		}
	}
}

fn is_early_websocket_message(message_kind: &protocol::mk2::ToServerTunnelMessageKind) -> bool {
	matches!(
		message_kind,
		protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketMessage(_)
			| protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketMessageAck(_)
	)
}

fn to_server_message_kind_name(
	message_kind: &protocol::mk2::ToServerTunnelMessageKind,
) -> &'static str {
	match message_kind {
		protocol::mk2::ToServerTunnelMessageKind::ToServerResponseStart(_) => {
			"ToServerResponseStart"
		}
		protocol::mk2::ToServerTunnelMessageKind::ToServerResponseChunk(_) => {
			"ToServerResponseChunk"
		}
		protocol::mk2::ToServerTunnelMessageKind::ToServerResponseAbort => "ToServerResponseAbort",
		protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketOpen(_) => {
			"ToServerWebSocketOpen"
		}
		protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketMessage(_) => {
			"ToServerWebSocketMessage"
		}
		protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketMessageAck(_) => {
			"ToServerWebSocketMessageAck"
		}
		protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketClose(_) => {
			"ToServerWebSocketClose"
		}
	}
}

struct InFlightRequest {
	/// UPS subject to send messages to for this request.
	receiver_subject: String,
	protocol_version: u16,
	state: InFlightRequestState,
	/// Sender for incoming messages to this request.
	msg_tx: mpsc::Sender<protocol::mk2::ToServerTunnelMessageKind>,
	/// Used to check if the request handler has been dropped.
	drop_tx: watch::Sender<Option<MsgGcReason>>,
	/// True once first message for this request has been sent (so runner learned reply_to).
	opened: bool,
	/// Message index counter for this request.
	message_index: protocol::mk2::MessageIndex,
	early_websocket_messages: VecDeque<EarlyWebSocketMessage>,
	hibernation_state: Option<HibernationState>,
	stopping: bool,
	last_pong: i64,
}

struct EarlyWebSocketMessage {
	message_index: protocol::mk2::MessageIndex,
	message_kind: protocol::mk2::ToServerTunnelMessageKind,
}

struct HibernationState {
	total_pending_ws_msgs_size: u64,
	pending_ws_msgs: Vec<PendingWebsocketMessage>,
	last_ws_message_index: Option<protocol::mk2::MessageIndex>,
	// Used to keep hibernating websockets from being GC'd
	last_ping: Instant,
}

pub struct PendingWebsocketMessage {
	payload: Vec<u8>,
	send_instant: Instant,
	message_index: protocol::mk2::MessageIndex,
}

#[derive(Debug)]
struct HibernationResumeGap {
	kind: HibernationResumeGapKind,
	ack_index: protocol::mk2::MessageIndex,
	first_pending_index: Option<protocol::mk2::MessageIndex>,
	last_sent_index: Option<protocol::mk2::MessageIndex>,
}

#[derive(Debug)]
enum HibernationResumeGapKind {
	StaleAck,
	AckBeyondTail,
}

#[derive(Debug)]
pub enum MsgGcReason {
	/// Gateway channel is closed and is not hibernating
	GatewayClosed,
	/// WebSocket pending messages (ToServerWebSocketMessageAck)
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
	gateway_id: protocol::mk2::GatewayId,
	receiver_subject: String,
	in_flight_requests: HashMap<protocol::mk2::RequestId, InFlightRequest>,
	tunnel_v2_adapter: Mutex<GatewayToRunnerAdapter>,
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
			tunnel_v2_adapter: Mutex::new(GatewayToRunnerAdapter::new()),
			hibernation_timeout: pegboard_config.hibernating_request_eligible_threshold(),
			gc_interval: Duration::from_millis(pegboard_config.gateway_gc_interval_ms()),
			tunnel_ping_timeout: pegboard_config.gateway_tunnel_ping_timeout_ms(),
			hws_message_ack_timeout: Duration::from_millis(
				pegboard_config.gateway_hws_message_ack_timeout_ms(),
			),
			hws_max_pending_size: pegboard_config.gateway_hws_max_pending_size(),
		}))
	}

	pub fn gateway_id(&self) -> protocol::mk2::GatewayId {
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

	#[tracing::instrument(skip_all, fields(%receiver_subject, request_id=%protocol::util::id_to_string(&request_id)))]
	pub async fn start_in_flight_request(
		&self,
		receiver_subject: String,
		protocol_version: u16,
		request_id: protocol::mk2::RequestId,
		state: InFlightRequestState,
	) -> InFlightRequestHandle {
		let (msg_tx, msg_rx) = mpsc::channel(128);
		let (drop_tx, drop_rx) = watch::channel(None);

		let new = match self.in_flight_requests.entry_async(request_id).await {
			Entry::Vacant(entry) => {
				entry.insert_entry(InFlightRequest {
					receiver_subject,
					protocol_version,
					state,
					msg_tx,
					drop_tx,
					opened: false,
					message_index: 0,
					early_websocket_messages: VecDeque::new(),
					hibernation_state: None,
					stopping: false,
					last_pong: util::timestamp::now(),
				});

				true
			}
			// Existing entries are either hibernating WebSockets waking up or retrying
			// HTTP/WebSocket-open requests reusing the same request id after route refresh.
			Entry::Occupied(mut entry) => {
				entry.receiver_subject = receiver_subject;
				entry.protocol_version = protocol_version;
				entry.msg_tx = msg_tx;
				entry.drop_tx = drop_tx;
				entry.state = state;
				entry.opened = false;
				entry.early_websocket_messages.clear();
				entry.last_pong = util::timestamp::now();

				if matches!(
					state,
					InFlightRequestState::AwaitingHttpResponseStart
						| InFlightRequestState::AwaitingWebSocketOpen
				) {
					entry.message_index = 0;
					entry.hibernation_state = None;
				}

				if entry.stopping {
					entry.hibernation_state = None;
					entry.stopping = false;
				}

				false
			}
		};

		InFlightRequestHandle {
			msg_rx,
			drop_rx,
			new,
		}
	}

	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&request_id)))]
	pub async fn send_message(
		&self,
		request_id: protocol::mk2::RequestId,
		message_kind: protocol::mk2::ToClientTunnelMessageKind,
	) -> Result<()> {
		self.send_messages(request_id, vec![message_kind]).await
	}

	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&request_id)))]
	pub async fn send_messages(
		&self,
		request_id: protocol::mk2::RequestId,
		message_kinds: Vec<protocol::mk2::ToClientTunnelMessageKind>,
	) -> Result<()> {
		if message_kinds.is_empty() {
			return Ok(());
		}

		let mut req = self
			.in_flight_requests
			.get_async(&request_id)
			.await
			.context("request not in flight")?;

		let include_reply_to = !req.opened;
		if include_reply_to {
			// Mark as opened so subsequent messages skip reply_to
			req.opened = true;
		}

		struct OutboundMessage {
			message_index: protocol::mk2::MessageIndex,
			is_ws_message: bool,
			payload: protocol::mk2::ToClientTunnelMessage,
		}

		let force_individual_waves = message_kinds.len() > 1 && req.hibernation_state.is_some();
		let mut payloads = Vec::with_capacity(message_kinds.len());
		for message_kind in message_kinds {
			let current_message_index = req.message_index;
			req.message_index = req.message_index.wrapping_add(1);

			let is_ws_message = matches!(
				message_kind,
				protocol::mk2::ToClientTunnelMessageKind::ToClientWebSocketMessage(_)
			);

			payloads.push(OutboundMessage {
				message_index: current_message_index,
				is_ws_message,
				payload: protocol::mk2::ToClientTunnelMessage {
					message_id: protocol::mk2::MessageId {
						gateway_id: self.gateway_id,
						request_id,
						message_index: current_message_index,
					},
					message_kind,
				},
			});
		}

		let messages_serialized = if req.protocol_version >= PROTOCOL_MK2_VERSION {
			if force_individual_waves {
				let mut adapter = self.tunnel_v2_adapter.lock().await;
				let mut serialized = Vec::with_capacity(payloads.len());
				for outbound in payloads {
					let wave = adapter
						.build_waves([outbound.payload], None)?
						.into_iter()
						.next()
						.context("gateway TickWave adapter returned no waves")?;
					let message = protocol::mk2::ToRunner::ToClientTickWave(
						protocol::mk2::ToClientTickWave { wave },
					);
					serialized.push((
						outbound.is_ws_message.then_some(outbound.message_index),
						versioned::ToRunnerMk2::wrap_latest(message)
							.serialize_with_embedded_version(PROTOCOL_MK2_VERSION)?,
					));
				}
				serialized
			} else {
				let pending_ws_index = payloads
					.iter()
					.find_map(|payload| payload.is_ws_message.then_some(payload.message_index));
				let wave = {
					let mut adapter = self.tunnel_v2_adapter.lock().await;
					adapter
						.build_waves(payloads.into_iter().map(|outbound| outbound.payload), None)?
				};
				ensure!(
					!wave.is_empty(),
					"gateway TickWave adapter returned no waves"
				);
				wave.into_iter()
					.enumerate()
					.map(|(index, wave)| {
						let message = protocol::mk2::ToRunner::ToClientTickWave(
							protocol::mk2::ToClientTickWave { wave },
						);
						Ok((
							(index == 0).then_some(pending_ws_index).flatten(),
							versioned::ToRunnerMk2::wrap_latest(message)
								.serialize_with_embedded_version(PROTOCOL_MK2_VERSION)?,
						))
					})
					.collect::<Result<Vec<_>>>()?
			}
		} else if protocol::is_mk2(req.protocol_version) {
			payloads
				.into_iter()
				.map(|outbound| {
					let message = protocol::mk2::ToRunner::ToClientTunnelMessage(outbound.payload);
					Ok((
						outbound.is_ws_message.then_some(outbound.message_index),
						versioned::ToRunnerMk2::wrap_latest(message)
							.serialize_with_embedded_version(PROTOCOL_MK2_VERSION)?,
					))
				})
				.collect::<Result<Vec<_>>>()?
		} else {
			payloads
				.into_iter()
				.map(|outbound| {
					let message = protocol::ToRunner::ToClientTunnelMessage(
						versioned::to_client_tunnel_message_mk2_to_mk1(outbound.payload),
					);
					Ok((
						outbound.is_ws_message.then_some(outbound.message_index),
						versioned::ToRunner::wrap_latest(message)
							.serialize_with_embedded_version(PROTOCOL_MK1_VERSION)?,
					))
				})
				.collect::<Result<Vec<_>>>()?
		};

		if let Some(hs) = &mut req.hibernation_state {
			for (message_index, message_serialized) in &messages_serialized {
				let Some(message_index) = message_index else {
					continue;
				};

				hs.total_pending_ws_msgs_size += message_serialized.len() as u64;

				if hs.total_pending_ws_msgs_size > self.hws_max_pending_size
					|| hs.pending_ws_msgs.len() >= u16::MAX as usize
				{
					return Err(WebsocketPendingLimitReached {}.build());
				}

				let pending_ws_msg = PendingWebsocketMessage {
					payload: message_serialized.clone(),
					send_instant: Instant::now(),
					message_index: *message_index,
				};

				hs.pending_ws_msgs.push(pending_ws_msg);
				hs.last_ws_message_index = Some(*message_index);
				tracing::debug!(
					index = message_index,
					new_count = hs.pending_ws_msgs.len(),
					"pushed pending websocket message"
				);
			}
		}

		let pressure_update = if req.protocol_version >= PROTOCOL_MK2_VERSION {
			req.hibernation_state.as_ref().map(|hs| {
				(
					req.receiver_subject.clone(),
					request_id,
					hibernation_pressure(hs, self.hws_max_pending_size),
				)
			})
		} else {
			None
		};

		for (_, message_serialized) in messages_serialized {
			self.ups
				.publish(
					&req.receiver_subject,
					&message_serialized,
					PublishOpts::one(),
				)
				.await?;
		}

		if let Some((receiver_subject, request_id, pressure)) = pressure_update {
			self.publish_tunnel_pressure(&receiver_subject, Some(request_id), pressure)
				.await?;
		}

		Ok(())
	}

	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&request_id)))]
	pub async fn send_and_check_ping(&self, request_id: protocol::mk2::RequestId) -> Result<()> {
		let req = self
			.in_flight_requests
			.get_async(&request_id)
			.await
			.context("request not in flight")?;

		let now = util::timestamp::now();

		// Verify ping timeout
		if now.saturating_sub(req.last_pong) > self.tunnel_ping_timeout {
			tracing::warn!(runner_topic=%req.receiver_subject, "tunnel timeout");
			return Err(WebSocketServiceTimeout.build());
		}

		let message_serialized = if protocol::is_mk2(req.protocol_version) {
			let message = protocol::mk2::ToRunner::ToRunnerPing(protocol::mk2::ToRunnerPing {
				gateway_id: self.gateway_id,
				request_id,
				ts: now,
			});
			versioned::ToRunnerMk2::wrap_latest(message)
				.serialize_with_embedded_version(PROTOCOL_MK2_VERSION)?
		} else {
			let message = protocol::ToRunner::ToRunnerPing(protocol::ToRunnerPing {
				gateway_id: self.gateway_id,
				request_id,
				ts: now,
			});
			versioned::ToRunner::wrap_latest(message)
				.serialize_with_embedded_version(PROTOCOL_MK1_VERSION)?
		};

		self.ups
			.publish(
				&req.receiver_subject,
				&message_serialized,
				PublishOpts::one(),
			)
			.await?;

		Ok(())
	}

	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&request_id)))]
	pub async fn keepalive_hws(&self, request_id: protocol::mk2::RequestId) -> Result<()> {
		let mut req = self
			.in_flight_requests
			.get_async(&request_id)
			.await
			.context("request not in flight")?;

		if let Some(hs) = &mut req.hibernation_state {
			hs.last_ping = Instant::now();
		} else {
			tracing::warn!("should not call keepalive_hws for non-hibernating ws");
		}

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

				tracing::trace!(
					payload_len = msg.payload.len(),
					"received message from pubsub"
				);

				match versioned::ToGateway::deserialize_with_embedded_version(&msg.payload) {
					Ok(protocol::mk2::ToGateway::ToGatewayPong(pong)) => {
						let Some(mut in_flight) =
							self.in_flight_requests.get_async(&pong.request_id).await
						else {
							tracing::debug!(
								request_id=%protocol::util::id_to_string(&pong.request_id),
								"in flight has already been disconnected, dropping ping"
							);
							continue;
						};

						let now = util::timestamp::now();
						in_flight.last_pong = now;

						let rtt = now.saturating_sub(pong.ts);
						metrics::TUNNEL_PING_DURATION.observe(rtt as f64 * 0.001);
					}
					Ok(protocol::mk2::ToGateway::ToServerTunnelMessage(msg)) => {
						self.recv_tunnel_message(msg).await;
					}
					Ok(protocol::mk2::ToGateway::ToServerTickWave(tick_wave)) => {
						match runner_gateway::wave_to_tunnel_messages_fair(&tick_wave.wave) {
							Ok(messages) => {
								for msg in messages {
									self.recv_tunnel_message(msg).await;
								}
							}
							Err(err) => {
								tracing::error!(?err, "failed to decode Tunnel v2 wave");
							}
						}
					}
					Ok(protocol::mk2::ToGateway::ToServerTunnelControl(control)) => {
						if let Err(err) = self.recv_tunnel_control(control).await {
							tracing::warn!(?err, "failed to apply Tunnel v2 control message");
						}
					}
					Err(err) => {
						tracing::error!(?err, "failed to parse message");
					}
				}
			}
		}
	}

	async fn recv_tunnel_control(
		&self,
		control: protocol::mk2::ToServerTunnelControl,
	) -> Result<()> {
		match control.control {
			protocol::mk2::TunnelControl::TunnelAck(ack) => self.recv_tunnel_ack(ack).await,
			protocol::mk2::TunnelControl::TunnelResume(resume) => {
				self.recv_tunnel_resume(resume).await
			}
			protocol::mk2::TunnelControl::TunnelPressure(pressure) => {
				self.recv_tunnel_pressure(pressure).await;
				Ok(())
			}
		}
	}

	async fn recv_tunnel_ack(&self, ack: protocol::mk2::TunnelAck) -> Result<()> {
		if !self.accept_tunnel_control_route(ack.gateway_id, Some(ack.request_id), "ack") {
			return Ok(());
		}

		if !self
			.tunnel_control_request_in_flight(ack.request_id, "ack")
			.await
		{
			return Ok(());
		}

		let Some(ack_index) = tunnel_control_ack_index(ack.last_acked_seq, "ack") else {
			return Ok(());
		};

		self.ack_pending_websocket_messages(ack.request_id, ack_index)
			.await
	}

	async fn recv_tunnel_resume(&self, resume: protocol::mk2::TunnelResume) -> Result<()> {
		if !self.accept_tunnel_control_route(resume.gateway_id, Some(resume.request_id), "resume") {
			return Ok(());
		}

		if !self
			.tunnel_control_request_in_flight(resume.request_id, "resume")
			.await
		{
			return Ok(());
		}

		let Some(ack_index) = tunnel_control_ack_index(resume.last_acked_seq, "resume") else {
			return Ok(());
		};

		if let Some(gap) = self
			.hibernation_resume_gap(resume.request_id, ack_index)
			.await?
		{
			tracing::warn!(
				gap_kind=?gap.kind,
				ack_index=gap.ack_index,
				first_pending_index=?gap.first_pending_index,
				last_sent_index=?gap.last_sent_index,
				request_id=%protocol::util::id_to_string(&resume.request_id),
				"closing Tunnel v2 websocket resume with a replay gap"
			);
			self.send_hibernation_resume_gap_close(resume.request_id)
				.await?;
			return Ok(());
		}

		self.ack_pending_websocket_messages(resume.request_id, ack_index)
			.await?;
		self.resend_pending_websocket_messages(resume.request_id)
			.await
	}

	async fn recv_tunnel_pressure(&self, pressure: protocol::mk2::TunnelPressure) {
		if !self.accept_tunnel_control_route(pressure.gateway_id, pressure.request_id, "pressure") {
			return;
		}

		if let Some(request_id) = pressure.request_id {
			if !self
				.tunnel_control_request_in_flight(request_id, "pressure")
				.await
			{
				return;
			}
		}

		tracing::debug!(
			gateway_id=%protocol::util::id_to_string(&pressure.gateway_id),
			request_id=?pressure.request_id,
			credit=pressure.pressure.credit,
			queue_depth=pressure.pressure.queue_depth,
			oldest_age_ms=?pressure.pressure.oldest_age_ms,
			"received Tunnel v2 pressure"
		);
	}

	fn accept_tunnel_control_route(
		&self,
		gateway_id: protocol::mk2::GatewayId,
		request_id: Option<protocol::mk2::RequestId>,
		control_kind: &'static str,
	) -> bool {
		if gateway_id != self.gateway_id {
			tracing::warn!(
				gateway_id=%protocol::util::id_to_string(&gateway_id),
				expected_gateway_id=%protocol::util::id_to_string(&self.gateway_id),
				?request_id,
				control_kind,
				"dropping Tunnel v2 control for another gateway"
			);
			return false;
		}

		true
	}

	async fn tunnel_control_request_in_flight(
		&self,
		request_id: protocol::mk2::RequestId,
		control_kind: &'static str,
	) -> bool {
		if self
			.in_flight_requests
			.get_async(&request_id)
			.await
			.is_some()
		{
			return true;
		}

		tracing::warn!(
			request_id=%protocol::util::id_to_string(&request_id),
			control_kind,
			"dropping Tunnel v2 control for request that is not in flight"
		);
		false
	}

	async fn recv_tunnel_message(&self, msg: protocol::mk2::ToServerTunnelMessage) {
		let message_id = msg.message_id;

		let Some(mut in_flight) = self
			.in_flight_requests
			.get_async(&message_id.request_id)
			.await
		else {
			tracing::warn!(
				gateway_id=%protocol::util::id_to_string(&message_id.gateway_id),
				request_id=%protocol::util::id_to_string(&message_id.request_id),
				message_index=message_id.message_index,
				"in flight has already been disconnected, dropping message"
			);
			return;
		};

		if matches!(in_flight.state, InFlightRequestState::AwaitingWebSocketOpen)
			&& is_early_websocket_message(&msg.message_kind)
		{
			if in_flight.early_websocket_messages.len() < MAX_EARLY_WEBSOCKET_MESSAGES {
				let buffered_count = in_flight.early_websocket_messages.len() + 1;
				in_flight
					.early_websocket_messages
					.push_back(EarlyWebSocketMessage {
						message_index: message_id.message_index,
						message_kind: msg.message_kind,
					});
				tracing::debug!(
					gateway_id=%protocol::util::id_to_string(&message_id.gateway_id),
					request_id=%protocol::util::id_to_string(&message_id.request_id),
					message_index=message_id.message_index,
					buffered_count,
					message_kind=to_server_message_kind_name(&in_flight.early_websocket_messages.back().expect("buffered message").message_kind),
					"buffering websocket tunnel message until open ack"
				);
			} else {
				tracing::warn!(
					gateway_id=%protocol::util::id_to_string(&message_id.gateway_id),
					request_id=%protocol::util::id_to_string(&message_id.request_id),
					message_index=message_id.message_index,
					buffered_count=in_flight.early_websocket_messages.len(),
					message_kind=to_server_message_kind_name(&msg.message_kind),
					"early websocket message buffer full, dropping message"
				);
			}
			return;
		}

		if !in_flight.state.accept_message(&msg.message_kind) {
			tracing::warn!(
				gateway_id=%protocol::util::id_to_string(&message_id.gateway_id),
				request_id=%protocol::util::id_to_string(&message_id.request_id),
				message_index=message_id.message_index,
				state=?in_flight.state,
				message_kind=to_server_message_kind_name(&msg.message_kind),
				inner_size=runner_gateway::tunnel_message_inner_data_len(&msg.message_kind),
				"dropping invalid tunnel message for request state"
			);
			return;
		}

		let mut message_kinds = Vec::new();
		let opened_websocket = matches!(
			msg.message_kind,
			protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketOpen(_)
		);
		let closed_websocket = matches!(
			msg.message_kind,
			protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketClose(_)
		);
		message_kinds.push(msg.message_kind.clone());

		if opened_websocket {
			let early_count = in_flight.early_websocket_messages.len();
			if early_count > 0 {
				let mut early_messages: Vec<_> =
					in_flight.early_websocket_messages.drain(..).collect();
				early_messages.sort_by_key(|message| message.message_index);
				message_kinds.extend(
					early_messages
						.into_iter()
						.map(|message| message.message_kind),
				);
				tracing::debug!(
					gateway_id=%protocol::util::id_to_string(&message_id.gateway_id),
					request_id=%protocol::util::id_to_string(&message_id.request_id),
					early_count,
					"replaying websocket tunnel messages buffered before open ack"
				);
			}
		} else if closed_websocket {
			in_flight.early_websocket_messages.clear();
		}

		let inner_size = match &message_kinds[0] {
			protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketMessage(ws_msg) => {
				ws_msg.data.len()
			}
			_ => 0,
		};
		tracing::debug!(
			gateway_id=%protocol::util::id_to_string(&message_id.gateway_id),
			request_id=%protocol::util::id_to_string(&message_id.request_id),
			message_index=message_id.message_index,
			inner_size,
			"forwarding message to request handler"
		);
		for message_kind in message_kinds {
			if in_flight.msg_tx.send(message_kind).await.is_err() {
				tracing::warn!(
					gateway_id=%protocol::util::id_to_string(&message_id.gateway_id),
					request_id=%protocol::util::id_to_string(&message_id.request_id),
					receiver_subject=%in_flight.receiver_subject,
					"message handler channel closed",
				);
				break;
			}
		}
	}

	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&request_id), %enable))]
	pub async fn toggle_hibernation(
		&self,
		request_id: protocol::mk2::RequestId,
		enable: bool,
	) -> Result<()> {
		let mut req = self
			.in_flight_requests
			.get_async(&request_id)
			.await
			.context("request not in flight")?;

		match (req.hibernation_state.is_some(), enable) {
			(true, true) => {}
			(true, false) => req.hibernation_state = None,
			(false, true) => {
				req.hibernation_state = Some(HibernationState {
					total_pending_ws_msgs_size: 0,
					pending_ws_msgs: Vec::new(),
					last_ws_message_index: None,
					last_ping: Instant::now(),
				});
			}
			(false, false) => {}
		}

		Ok(())
	}

	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&request_id)))]
	pub async fn resend_pending_websocket_messages(
		&self,
		request_id: protocol::mk2::RequestId,
	) -> Result<()> {
		let Some(mut req) = self.in_flight_requests.get_async(&request_id).await else {
			bail!("request not in flight");
		};

		let receiver_subject = req.receiver_subject.clone();

		if let Some(hs) = &mut req.hibernation_state {
			if !hs.pending_ws_msgs.is_empty() {
				tracing::debug!(len=?hs.pending_ws_msgs.len(), "resending pending messages");

				for pending_msg in &hs.pending_ws_msgs {
					self.ups
						.publish(&receiver_subject, &pending_msg.payload, PublishOpts::one())
						.await?;
				}
			}
		}

		Ok(())
	}

	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&request_id)))]
	pub async fn has_pending_websocket_messages(
		&self,
		request_id: protocol::mk2::RequestId,
	) -> Result<bool> {
		let Some(req) = self.in_flight_requests.get_async(&request_id).await else {
			bail!("request not in flight");
		};

		if let Some(hs) = &req.hibernation_state {
			Ok(!hs.pending_ws_msgs.is_empty())
		} else {
			Ok(false)
		}
	}

	#[tracing::instrument(skip_all, fields(request_id=%protocol::util::id_to_string(&request_id), %ack_index))]
	pub async fn ack_pending_websocket_messages(
		&self,
		request_id: protocol::mk2::RequestId,
		ack_index: u16,
	) -> Result<()> {
		let pressure_update = {
			let Some(mut req) = self.in_flight_requests.get_async(&request_id).await else {
				bail!("request not in flight");
			};
			let protocol_version = req.protocol_version;
			let receiver_subject = req.receiver_subject.clone();

			let Some(hs) = &mut req.hibernation_state else {
				tracing::warn!("cannot ack ws messages, hibernation is not enabled");
				return Ok(());
			};

			// Retain messages with index > ack_index (messages that haven't been acknowledged yet)
			let len_before = hs.pending_ws_msgs.len();
			let mut removed_bytes = 0_u64;
			hs.pending_ws_msgs.retain(|msg| {
				let keep = wrapping_gt(msg.message_index, ack_index);
				if !keep {
					removed_bytes += msg.payload.len() as u64;
				}
				keep
			});
			hs.total_pending_ws_msgs_size =
				hs.total_pending_ws_msgs_size.saturating_sub(removed_bytes);

			let len_after = hs.pending_ws_msgs.len();
			tracing::debug!(
				removed_count = len_before - len_after,
				removed_bytes,
				remaining_count = len_after,
				"acked pending websocket messages"
			);

			if protocol_version >= PROTOCOL_MK2_VERSION {
				Some((
					receiver_subject,
					request_id,
					hibernation_pressure(hs, self.hws_max_pending_size),
				))
			} else {
				None
			}
		};

		if let Some((receiver_subject, request_id, pressure)) = pressure_update {
			self.publish_tunnel_pressure(&receiver_subject, Some(request_id), pressure)
				.await?;
		}

		Ok(())
	}

	async fn publish_tunnel_pressure(
		&self,
		receiver_subject: &str,
		request_id: Option<protocol::mk2::RequestId>,
		pressure: protocol::mk2::Pressure,
	) -> Result<()> {
		let message =
			protocol::mk2::ToRunner::ToClientTunnelControl(protocol::mk2::ToClientTunnelControl {
				control: protocol::mk2::TunnelControl::TunnelPressure(
					protocol::mk2::TunnelPressure {
						gateway_id: self.gateway_id,
						request_id,
						pressure,
					},
				),
			});
		let serialized = versioned::ToRunnerMk2::wrap_latest(message)
			.serialize_with_embedded_version(PROTOCOL_MK2_VERSION)?;

		self.ups
			.publish(receiver_subject, &serialized, PublishOpts::one())
			.await?;

		Ok(())
	}

	async fn hibernation_resume_gap(
		&self,
		request_id: protocol::mk2::RequestId,
		ack_index: protocol::mk2::MessageIndex,
	) -> Result<Option<HibernationResumeGap>> {
		let Some(req) = self.in_flight_requests.get_async(&request_id).await else {
			bail!("request not in flight");
		};
		let Some(hs) = &req.hibernation_state else {
			return Ok(None);
		};

		Ok(classify_hibernation_resume_gap(hs, ack_index))
	}

	async fn send_hibernation_resume_gap_close(
		&self,
		request_id: protocol::mk2::RequestId,
	) -> Result<()> {
		self.send_message(
			request_id,
			protocol::mk2::ToClientTunnelMessageKind::ToClientWebSocketClose(
				protocol::mk2::ToClientWebSocketClose {
					code: Some(HIBERNATION_RESUME_GAP_CLOSE_CODE),
					reason: Some(HIBERNATION_RESUME_GAP_REASON.to_string()),
				},
			),
		)
		.await
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

	/// This will remove all in flight requests that are cancelled or had an ack timeout.
	///
	/// Purging requests is done in a 2 phase commit in order to ensure that the InFlightRequest is
	/// kept until the ToClientWebSocketClose message has been successfully sent.
	///
	/// If we did not use a 2 phase commit (i.e. a single `retain` for any GC purge), the
	/// InFlightRequest would be removed immediately and the runner would never receive the
	/// ToClientWebSocketClose.
	///
	/// **Phase 1**
	///
	/// 1a. Find requests that need to be purged (either closed by gateway or message acknowledgement took too long)
	/// 1b. Flag the request as `stopping` to prevent re-purging this request in the next GC tick
	/// 1c. Send a `Timeout` message to `msg_tx` which will terminate the task in `handle_websocket`
	/// 1d. Once both tasks terminate, `handle_websocket` sends the `ToClientWebSocketClose` to the in flight request
	/// 1e. `handle_websocket` exits and drops `drop_rx`
	///
	/// **Phase 2**
	///
	/// 2a. Remove all requests where it was flagged as stopping and `drop_rx` has been dropped
	#[tracing::instrument(skip_all)]
	async fn gc_in_flight_requests(&self) {
		let now = Instant::now();
		let hibernation_timeout =
			Duration::from_millis(self.hibernation_timeout.try_into().unwrap_or(90_000));

		// First, check if an in flight req is beyond the timeout for tunnel message ack and websocket
		// message ack
		self.in_flight_requests
			.iter_mut_async(|mut entry| {
				let request_id = entry.key().clone();
				let req = &mut *entry;

				if req.stopping {
					return true;
				}

				let reason = 'reason: {
					if let Some(hs) = &req.hibernation_state {
						if let Some(earliest_pending_ws_msg) = hs.pending_ws_msgs.first() {
							if now.duration_since(earliest_pending_ws_msg.send_instant) > self.hws_message_ack_timeout {
								break 'reason Some(MsgGcReason::WebSocketMessageNotAcked {
									first_msg_index: earliest_pending_ws_msg.message_index,
									last_msg_index: req.message_index,
								});
							}
						}

						let hs_elapsed = hs.last_ping.elapsed();
						tracing::debug!(
							hs_elapsed=%hs_elapsed.as_secs_f64(),
							timeout=%hibernation_timeout.as_secs_f64(),
							"checking hibernating state elapsed time"
						);
						if hs_elapsed > hibernation_timeout {
							break 'reason Some(MsgGcReason::HibernationTimeout);
						}
					} else if req.msg_tx.is_closed() {
						break 'reason Some(MsgGcReason::GatewayClosed);
					}

					None
				};

				if let Some(reason) = reason {
					tracing::debug!(
						request_id=%protocol::util::id_to_string(&request_id),
						?reason,
						"gc stopping in flight request"
					);

					if req.drop_tx.send(Some(reason)).is_err() {
						tracing::debug!(request_id=%protocol::util::id_to_string(&request_id), "failed to send timeout msg to tunnel");
					}

					// Mark req as stopping to skip this loop next time the gc is run
					req.stopping = true;
				}

				true
			})
			.await;

		self.in_flight_requests
			.retain_async(|request_id, req| {
				// The reason we check for stopping here is because drop_tx could be dropped if we are
				// between websocket retries (we don't want to remove the in flight req in this case).
				// When the websocket reconnects a new channel will be created
				if req.stopping && req.drop_tx.is_closed() {
					tracing::debug!(
						request_id=%protocol::util::id_to_string(request_id),
						"gc removing in flight request"
					);

					return false;
				}

				true
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

fn wrapping_gt(a: u16, b: u16) -> bool {
	a != b && a.wrapping_sub(b) < u16::MAX / 2
}

fn classify_hibernation_resume_gap(
	hs: &HibernationState,
	ack_index: protocol::mk2::MessageIndex,
) -> Option<HibernationResumeGap> {
	let first_pending_index = hs.pending_ws_msgs.first().map(|msg| msg.message_index);
	let last_sent_index = hs.last_ws_message_index;
	let gap = |kind| HibernationResumeGap {
		kind,
		ack_index,
		first_pending_index,
		last_sent_index,
	};

	match (first_pending_index, last_sent_index) {
		(_, None) => (ack_index != 0).then(|| gap(HibernationResumeGapKind::AckBeyondTail)),
		(None, Some(last_sent)) => {
			if ack_index == last_sent {
				None
			} else if wrapping_gt(ack_index, last_sent) {
				Some(gap(HibernationResumeGapKind::AckBeyondTail))
			} else {
				Some(gap(HibernationResumeGapKind::StaleAck))
			}
		}
		(Some(first_pending), Some(last_sent)) => {
			let first_replayable_ack = first_pending.wrapping_sub(1);
			if wrapping_gt(first_replayable_ack, ack_index) {
				Some(gap(HibernationResumeGapKind::StaleAck))
			} else if wrapping_gt(ack_index, last_sent) {
				Some(gap(HibernationResumeGapKind::AckBeyondTail))
			} else {
				None
			}
		}
	}
}

fn tunnel_control_ack_index(last_acked_seq: u64, control_kind: &'static str) -> Option<u16> {
	match u16::try_from(last_acked_seq) {
		Ok(ack_index) => Some(ack_index),
		Err(_) => {
			tracing::warn!(
				last_acked_seq,
				control_kind,
				"dropping Tunnel v2 control with out-of-range ack sequence"
			);
			None
		}
	}
}

fn hibernation_pressure(hs: &HibernationState, max_pending_size: u64) -> protocol::mk2::Pressure {
	let credit = max_pending_size
		.saturating_sub(hs.total_pending_ws_msgs_size)
		.min(u64::from(u32::MAX)) as u32;
	let queue_depth = hs.pending_ws_msgs.len().min(u32::MAX as usize) as u32;
	let oldest_age_ms = hs
		.pending_ws_msgs
		.first()
		.map(|msg| u64::try_from(msg.send_instant.elapsed().as_millis()).unwrap_or(u64::MAX));

	protocol::mk2::Pressure {
		credit,
		queue_depth,
		oldest_age_ms,
	}
}

#[cfg(test)]
mod tests {
	use super::{InFlightRequestState, SharedState};
	use rivet_runner_protocol::{self as protocol, PROTOCOL_MK2_VERSION, versioned};
	use std::{sync::Arc, time::Duration};
	use tunnel_fabric::runner_gateway;
	use universalpubsub::{NextOutput, PubSub, Subscriber, driver::memory::MemoryDriver};
	use vbare::OwnedVersionedData;

	fn test_config() -> rivet_config::Config {
		rivet_config::Config::from_root(rivet_config::config::Root::default())
	}

	fn memory_pubsub(channel: &str) -> PubSub {
		PubSub::new(Arc::new(MemoryDriver::new(channel.to_string())))
	}

	fn request_chunk_message() -> protocol::mk2::ToClientTunnelMessageKind {
		protocol::mk2::ToClientTunnelMessageKind::ToClientRequestChunk(
			protocol::mk2::ToClientRequestChunk {
				body: b"chunk".to_vec(),
				finish: false,
			},
		)
	}

	fn websocket_message(body: &'static [u8]) -> protocol::mk2::ToClientTunnelMessageKind {
		protocol::mk2::ToClientTunnelMessageKind::ToClientWebSocketMessage(
			protocol::mk2::ToClientWebSocketMessage {
				data: body.to_vec(),
				binary: true,
			},
		)
	}

	fn server_tunnel_message(
		gateway_id: protocol::mk2::GatewayId,
		request_id: protocol::mk2::RequestId,
		message_index: protocol::mk2::MessageIndex,
		message_kind: protocol::mk2::ToServerTunnelMessageKind,
	) -> protocol::mk2::ToServerTunnelMessage {
		protocol::mk2::ToServerTunnelMessage {
			message_id: protocol::mk2::MessageId {
				gateway_id,
				request_id,
				message_index,
			},
			message_kind,
		}
	}

	fn server_websocket_message(body: &'static [u8]) -> protocol::mk2::ToServerTunnelMessageKind {
		protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketMessage(
			protocol::mk2::ToServerWebSocketMessage {
				data: body.to_vec(),
				binary: true,
			},
		)
	}

	fn server_websocket_open() -> protocol::mk2::ToServerTunnelMessageKind {
		protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketOpen(
			protocol::mk2::ToServerWebSocketOpen {
				can_hibernate: false,
			},
		)
	}

	fn server_websocket_close() -> protocol::mk2::ToServerTunnelMessageKind {
		protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketClose(
			protocol::mk2::ToServerWebSocketClose {
				code: Some(1000),
				reason: None,
				hibernate: false,
			},
		)
	}

	async fn next_runner_message(sub: &mut Subscriber) -> protocol::mk2::ToRunner {
		let msg = tokio::time::timeout(Duration::from_secs(1), sub.next())
			.await
			.unwrap()
			.unwrap();
		let NextOutput::Message(msg) = msg else {
			panic!("expected pubsub message");
		};
		versioned::ToRunnerMk2::deserialize_with_embedded_version(&msg.payload)
			.expect("runner payload should decode")
	}

	async fn next_tick_wave(sub: &mut Subscriber) -> protocol::mk2::ToClientTickWave {
		let decoded = next_runner_message(sub).await;
		let protocol::mk2::ToRunner::ToClientTickWave(tick_wave) = decoded else {
			panic!("expected Tunnel v2 TickWave");
		};
		tick_wave
	}

	async fn next_tunnel_pressure(sub: &mut Subscriber) -> protocol::mk2::TunnelPressure {
		let decoded = next_runner_message(sub).await;
		let protocol::mk2::ToRunner::ToClientTunnelControl(control) = decoded else {
			panic!("expected Tunnel v2 pressure control");
		};
		let protocol::mk2::TunnelControl::TunnelPressure(pressure) = control.control else {
			panic!("expected Tunnel v2 pressure control");
		};
		pressure
	}

	async fn assert_next_resume_gap_close(sub: &mut Subscriber) {
		let tick_wave = next_tick_wave(sub).await;
		let messages = runner_gateway::wave_to_client_messages(&tick_wave.wave).unwrap();
		assert_eq!(messages.len(), 1);
		let protocol::mk2::ToClientTunnelMessageKind::ToClientWebSocketClose(close) =
			&messages[0].message_kind
		else {
			panic!("expected websocket close");
		};
		assert_eq!(close.code, Some(super::HIBERNATION_RESUME_GAP_CLOSE_CODE));
		assert_eq!(
			close.reason.as_deref(),
			Some(super::HIBERNATION_RESUME_GAP_REASON)
		);
	}

	#[test]
	fn http_requests_only_accept_http_terminal_messages() {
		let mut state = InFlightRequestState::AwaitingHttpResponseStart;
		assert!(
			state.accept_message(&protocol::mk2::ToServerTunnelMessageKind::ToServerResponseAbort,)
		);
		assert_eq!(state, InFlightRequestState::Closed);

		let mut state = InFlightRequestState::AwaitingHttpResponseStart;
		assert!(!state.accept_message(
			&protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketMessage(
				protocol::mk2::ToServerWebSocketMessage {
					data: Vec::new(),
					binary: false,
				},
			),
		));
		assert_eq!(state, InFlightRequestState::AwaitingHttpResponseStart);
	}

	#[test]
	fn websockets_must_open_before_streaming() {
		let mut state = InFlightRequestState::AwaitingWebSocketOpen;
		assert!(!state.accept_message(
			&protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketMessage(
				protocol::mk2::ToServerWebSocketMessage {
					data: Vec::new(),
					binary: false,
				},
			),
		));
		assert_eq!(state, InFlightRequestState::AwaitingWebSocketOpen);

		assert!(state.accept_message(
			&protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketOpen(
				protocol::mk2::ToServerWebSocketOpen {
					can_hibernate: false,
				},
			),
		));
		assert_eq!(state, InFlightRequestState::ActiveWebSocket);
	}

	#[test]
	fn active_websockets_reject_http_messages() {
		let mut state = InFlightRequestState::ActiveWebSocket;
		assert!(
			!state
				.accept_message(&protocol::mk2::ToServerTunnelMessageKind::ToServerResponseAbort,)
		);
		assert_eq!(state, InFlightRequestState::ActiveWebSocket);
	}

	#[tokio::test]
	async fn websocket_messages_before_open_are_replayed_after_open() {
		let pubsub = memory_pubsub("pegboard-gateway-early-websocket-message");
		let state = SharedState::new(&test_config(), pubsub);
		let request_id = [55, 56, 57, 58];
		let mut handle = state
			.start_in_flight_request(
				"runner-early-ws".to_string(),
				PROTOCOL_MK2_VERSION,
				request_id,
				InFlightRequestState::AwaitingWebSocketOpen,
			)
			.await;

		state
			.recv_tunnel_message(server_tunnel_message(
				state.gateway_id(),
				request_id,
				2,
				server_websocket_message(b"early-two"),
			))
			.await;
		state
			.recv_tunnel_message(server_tunnel_message(
				state.gateway_id(),
				request_id,
				1,
				server_websocket_message(b"early-one"),
			))
			.await;

		assert!(handle.msg_rx.try_recv().is_err());

		state
			.recv_tunnel_message(server_tunnel_message(
				state.gateway_id(),
				request_id,
				0,
				server_websocket_open(),
			))
			.await;

		assert!(matches!(
			handle.msg_rx.recv().await,
			Some(protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketOpen(_))
		));

		let Some(protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketMessage(first)) =
			handle.msg_rx.recv().await
		else {
			panic!("expected first buffered websocket message");
		};
		assert_eq!(first.data, b"early-one".to_vec());

		let Some(protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketMessage(second)) =
			handle.msg_rx.recv().await
		else {
			panic!("expected second buffered websocket message");
		};
		assert_eq!(second.data, b"early-two".to_vec());
	}

	#[tokio::test]
	async fn websocket_close_before_open_drops_buffered_messages() {
		let pubsub = memory_pubsub("pegboard-gateway-early-websocket-close");
		let state = SharedState::new(&test_config(), pubsub);
		let request_id = [59, 60, 61, 62];
		let mut handle = state
			.start_in_flight_request(
				"runner-early-ws-close".to_string(),
				PROTOCOL_MK2_VERSION,
				request_id,
				InFlightRequestState::AwaitingWebSocketOpen,
			)
			.await;

		state
			.recv_tunnel_message(server_tunnel_message(
				state.gateway_id(),
				request_id,
				1,
				server_websocket_message(b"early"),
			))
			.await;
		state
			.recv_tunnel_message(server_tunnel_message(
				state.gateway_id(),
				request_id,
				2,
				server_websocket_close(),
			))
			.await;

		assert!(matches!(
			handle.msg_rx.recv().await,
			Some(protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketClose(_))
		));
		assert!(handle.msg_rx.try_recv().is_err());
	}

	#[tokio::test]
	async fn send_message_uses_tick_wave_for_protocol_v8() {
		let pubsub = memory_pubsub("pegboard-gateway-send-message-v8");
		let state = SharedState::new(&test_config(), pubsub.clone());
		let receiver_subject = "runner-v8".to_string();
		let mut sub = pubsub.subscribe(&receiver_subject).await.unwrap();
		let request_id = [1, 2, 3, 4];
		let _handle = state
			.start_in_flight_request(
				receiver_subject,
				PROTOCOL_MK2_VERSION,
				request_id,
				InFlightRequestState::AwaitingHttpResponseStart,
			)
			.await;

		state
			.send_message(request_id, request_chunk_message())
			.await
			.unwrap();

		let msg = tokio::time::timeout(Duration::from_secs(1), sub.next())
			.await
			.unwrap()
			.unwrap();
		let NextOutput::Message(msg) = msg else {
			panic!("expected pubsub message");
		};
		let decoded = versioned::ToRunnerMk2::deserialize_with_embedded_version(&msg.payload)
			.expect("runner payload should decode");
		let protocol::mk2::ToRunner::ToClientTickWave(tick_wave) = decoded else {
			panic!("expected Tunnel v2 TickWave");
		};
		assert_eq!(tick_wave.wave.gateway_id, state.gateway_id());
		assert_eq!(tick_wave.wave.frames.len(), 1);
		assert_eq!(tick_wave.wave.frames[0].request_id, request_id);

		let messages = runner_gateway::wave_to_client_messages(&tick_wave.wave).unwrap();
		assert_eq!(messages.len(), 1);
		assert_eq!(messages[0].message_id.gateway_id, state.gateway_id());
		assert_eq!(messages[0].message_id.request_id, request_id);
		assert!(matches!(
			messages[0].message_kind,
			protocol::mk2::ToClientTunnelMessageKind::ToClientRequestChunk(_)
		));
	}

	#[tokio::test]
	async fn send_messages_batches_protocol_v8_wave_frames() {
		let pubsub = memory_pubsub("pegboard-gateway-send-message-batch-v8");
		let state = SharedState::new(&test_config(), pubsub.clone());
		let receiver_subject = "runner-v8-batch".to_string();
		let mut sub = pubsub.subscribe(&receiver_subject).await.unwrap();
		let request_id = [9, 10, 11, 12];
		let _handle = state
			.start_in_flight_request(
				receiver_subject,
				PROTOCOL_MK2_VERSION,
				request_id,
				InFlightRequestState::ActiveWebSocket,
			)
			.await;

		state
			.send_messages(
				request_id,
				vec![websocket_message(b"one"), websocket_message(b"two")],
			)
			.await
			.unwrap();

		let msg = tokio::time::timeout(Duration::from_secs(1), sub.next())
			.await
			.unwrap()
			.unwrap();
		let NextOutput::Message(msg) = msg else {
			panic!("expected pubsub message");
		};
		let decoded = versioned::ToRunnerMk2::deserialize_with_embedded_version(&msg.payload)
			.expect("runner payload should decode");
		let protocol::mk2::ToRunner::ToClientTickWave(tick_wave) = decoded else {
			panic!("expected Tunnel v2 TickWave");
		};
		assert_eq!(tick_wave.wave.frames.len(), 2);
		assert_eq!(
			tick_wave.wave.frames[0].sequence_range,
			protocol::mk2::SequenceRange { first: 0, last: 0 }
		);
		assert_eq!(
			tick_wave.wave.frames[1].sequence_range,
			protocol::mk2::SequenceRange { first: 1, last: 1 }
		);
	}

	#[tokio::test]
	async fn send_messages_keeps_hibernating_replay_payloads_per_message() {
		let pubsub = memory_pubsub("pegboard-gateway-send-message-hibernate-v8");
		let state = SharedState::new(&test_config(), pubsub.clone());
		let receiver_subject = "runner-v8-hibernate".to_string();
		let mut sub = pubsub.subscribe(&receiver_subject).await.unwrap();
		let request_id = [13, 14, 15, 16];
		let _handle = state
			.start_in_flight_request(
				receiver_subject,
				PROTOCOL_MK2_VERSION,
				request_id,
				InFlightRequestState::ActiveWebSocket,
			)
			.await;
		state.toggle_hibernation(request_id, true).await.unwrap();

		state
			.send_messages(
				request_id,
				vec![websocket_message(b"one"), websocket_message(b"two")],
			)
			.await
			.unwrap();

		for expected_index in [0, 1] {
			let msg = tokio::time::timeout(Duration::from_secs(1), sub.next())
				.await
				.unwrap()
				.unwrap();
			let NextOutput::Message(msg) = msg else {
				panic!("expected pubsub message");
			};
			let decoded = versioned::ToRunnerMk2::deserialize_with_embedded_version(&msg.payload)
				.expect("runner payload should decode");
			let protocol::mk2::ToRunner::ToClientTickWave(tick_wave) = decoded else {
				panic!("expected Tunnel v2 TickWave");
			};
			assert_eq!(tick_wave.wave.frames.len(), 1);
			assert_eq!(
				tick_wave.wave.frames[0].sequence_range,
				protocol::mk2::SequenceRange {
					first: expected_index,
					last: expected_index,
				}
			);
		}

		let req = state
			.in_flight_requests
			.get_async(&request_id)
			.await
			.expect("request should still be tracked");
		let hibernation_state = req
			.hibernation_state
			.as_ref()
			.expect("hibernation should be enabled");
		assert_eq!(hibernation_state.pending_ws_msgs.len(), 2);
		assert_ne!(
			hibernation_state.pending_ws_msgs[0].payload,
			hibernation_state.pending_ws_msgs[1].payload
		);
	}

	#[tokio::test]
	async fn send_message_publishes_request_scoped_hibernation_pressure_for_protocol_v8() {
		let pubsub = memory_pubsub("pegboard-gateway-send-message-pressure-v8");
		let state = SharedState::new(&test_config(), pubsub.clone());
		let receiver_subject = "runner-v8-pressure".to_string();
		let mut sub = pubsub.subscribe(&receiver_subject).await.unwrap();
		let request_id = [17, 18, 19, 20];
		let _handle = state
			.start_in_flight_request(
				receiver_subject,
				PROTOCOL_MK2_VERSION,
				request_id,
				InFlightRequestState::ActiveWebSocket,
			)
			.await;
		state.toggle_hibernation(request_id, true).await.unwrap();

		state
			.send_message(request_id, websocket_message(b"one"))
			.await
			.unwrap();
		let first_wave = next_tick_wave(&mut sub).await;
		assert_eq!(first_wave.wave.backpressure, None);
		let first_pressure = next_tunnel_pressure(&mut sub).await;
		assert_eq!(first_pressure.gateway_id, state.gateway_id());
		assert_eq!(first_pressure.request_id, Some(request_id));
		assert_eq!(first_pressure.pressure.queue_depth, 1);
		assert!(first_pressure.pressure.credit > 0);
		assert!(first_pressure.pressure.oldest_age_ms.is_some());

		state
			.send_message(request_id, websocket_message(b"two"))
			.await
			.unwrap();
		let second_wave = next_tick_wave(&mut sub).await;
		assert_eq!(second_wave.wave.backpressure, None);
		let second_pressure = next_tunnel_pressure(&mut sub).await;
		assert_eq!(second_pressure.gateway_id, state.gateway_id());
		assert_eq!(second_pressure.request_id, Some(request_id));
		assert_eq!(second_pressure.pressure.queue_depth, 2);
		assert!(second_pressure.pressure.credit > 0);
		assert!(second_pressure.pressure.oldest_age_ms.is_some());
	}

	#[tokio::test]
	async fn ack_pending_websocket_messages_publishes_pressure_control_for_protocol_v8() {
		let pubsub = memory_pubsub("pegboard-gateway-ack-pressure-v8");
		let state = SharedState::new(&test_config(), pubsub.clone());
		let receiver_subject = "runner-v8-ack-pressure".to_string();
		let mut sub = pubsub.subscribe(&receiver_subject).await.unwrap();
		let request_id = [33, 34, 35, 36];
		let _handle = state
			.start_in_flight_request(
				receiver_subject,
				PROTOCOL_MK2_VERSION,
				request_id,
				InFlightRequestState::ActiveWebSocket,
			)
			.await;
		state.toggle_hibernation(request_id, true).await.unwrap();

		state
			.send_message(request_id, websocket_message(b"one"))
			.await
			.unwrap();
		let wave = next_tick_wave(&mut sub).await;
		assert_eq!(wave.wave.backpressure, None);
		let send_pressure = next_tunnel_pressure(&mut sub).await;
		assert_eq!(send_pressure.request_id, Some(request_id));
		assert_eq!(send_pressure.pressure.queue_depth, 1);

		state
			.ack_pending_websocket_messages(request_id, 0)
			.await
			.unwrap();

		let pressure = next_tunnel_pressure(&mut sub).await;
		assert_eq!(pressure.gateway_id, state.gateway_id());
		assert_eq!(pressure.request_id, Some(request_id));
		assert_eq!(pressure.pressure.queue_depth, 0);
		assert!(pressure.pressure.credit > 0);
		assert_eq!(pressure.pressure.oldest_age_ms, None);
	}

	#[tokio::test]
	async fn tunnel_ack_control_prunes_hibernation_replay() {
		let pubsub = memory_pubsub("pegboard-gateway-tunnel-ack-control");
		let state = SharedState::new(&test_config(), pubsub.clone());
		let receiver_subject = "runner-v8-ack-control".to_string();
		let request_id = [21, 22, 23, 24];
		let _handle = state
			.start_in_flight_request(
				receiver_subject,
				PROTOCOL_MK2_VERSION,
				request_id,
				InFlightRequestState::ActiveWebSocket,
			)
			.await;
		state.toggle_hibernation(request_id, true).await.unwrap();

		state
			.send_messages(
				request_id,
				vec![websocket_message(b"one"), websocket_message(b"two")],
			)
			.await
			.unwrap();

		state
			.recv_tunnel_control(protocol::mk2::ToServerTunnelControl {
				control: protocol::mk2::TunnelControl::TunnelAck(protocol::mk2::TunnelAck {
					gateway_id: state.gateway_id(),
					request_id,
					last_acked_seq: 0,
				}),
			})
			.await
			.unwrap();

		{
			let req = state
				.in_flight_requests
				.get_async(&request_id)
				.await
				.expect("request should still be tracked");
			let hibernation_state = req
				.hibernation_state
				.as_ref()
				.expect("hibernation should be enabled");
			assert_eq!(hibernation_state.pending_ws_msgs.len(), 1);
			assert_eq!(hibernation_state.pending_ws_msgs[0].message_index, 1);
			assert_eq!(
				hibernation_state.total_pending_ws_msgs_size,
				hibernation_state.pending_ws_msgs[0].payload.len() as u64
			);
		}

		state
			.recv_tunnel_control(protocol::mk2::ToServerTunnelControl {
				control: protocol::mk2::TunnelControl::TunnelAck(protocol::mk2::TunnelAck {
					gateway_id: state.gateway_id(),
					request_id,
					last_acked_seq: 1,
				}),
			})
			.await
			.unwrap();

		let req = state
			.in_flight_requests
			.get_async(&request_id)
			.await
			.expect("request should still be tracked");
		let hibernation_state = req
			.hibernation_state
			.as_ref()
			.expect("hibernation should be enabled");
		assert!(hibernation_state.pending_ws_msgs.is_empty());
		assert_eq!(hibernation_state.total_pending_ws_msgs_size, 0);
	}

	#[tokio::test]
	async fn tunnel_ack_control_ignores_other_gateway() {
		let pubsub = memory_pubsub("pegboard-gateway-tunnel-ack-other-gateway");
		let state = SharedState::new(&test_config(), pubsub.clone());
		let receiver_subject = "runner-v8-ack-other-gateway".to_string();
		let request_id = [25, 26, 27, 28];
		let _handle = state
			.start_in_flight_request(
				receiver_subject,
				PROTOCOL_MK2_VERSION,
				request_id,
				InFlightRequestState::ActiveWebSocket,
			)
			.await;
		state.toggle_hibernation(request_id, true).await.unwrap();

		state
			.send_messages(
				request_id,
				vec![websocket_message(b"one"), websocket_message(b"two")],
			)
			.await
			.unwrap();

		state
			.recv_tunnel_control(protocol::mk2::ToServerTunnelControl {
				control: protocol::mk2::TunnelControl::TunnelAck(protocol::mk2::TunnelAck {
					gateway_id: [99, 99, 99, 99],
					request_id,
					last_acked_seq: 1,
				}),
			})
			.await
			.unwrap();

		let req = state
			.in_flight_requests
			.get_async(&request_id)
			.await
			.expect("request should still be tracked");
		let hibernation_state = req
			.hibernation_state
			.as_ref()
			.expect("hibernation should be enabled");
		assert_eq!(hibernation_state.pending_ws_msgs.len(), 2);
	}

	#[tokio::test]
	async fn tunnel_resume_control_replays_unacked_hibernation_messages() {
		let pubsub = memory_pubsub("pegboard-gateway-tunnel-resume-control");
		let state = SharedState::new(&test_config(), pubsub.clone());
		let receiver_subject = "runner-v8-resume-control".to_string();
		let mut sub = pubsub.subscribe(&receiver_subject).await.unwrap();
		let request_id = [29, 30, 31, 32];
		let _handle = state
			.start_in_flight_request(
				receiver_subject,
				PROTOCOL_MK2_VERSION,
				request_id,
				InFlightRequestState::ActiveWebSocket,
			)
			.await;
		state.toggle_hibernation(request_id, true).await.unwrap();

		state
			.send_messages(
				request_id,
				vec![websocket_message(b"one"), websocket_message(b"two")],
			)
			.await
			.unwrap();

		for _ in 0..2 {
			let wave = next_tick_wave(&mut sub).await;
			assert_eq!(wave.wave.backpressure, None);
		}
		let send_pressure = next_tunnel_pressure(&mut sub).await;
		assert_eq!(send_pressure.request_id, Some(request_id));
		assert_eq!(send_pressure.pressure.queue_depth, 2);

		state
			.recv_tunnel_control(protocol::mk2::ToServerTunnelControl {
				control: protocol::mk2::TunnelControl::TunnelResume(protocol::mk2::TunnelResume {
					gateway_id: state.gateway_id(),
					request_id,
					last_acked_seq: 0,
				}),
			})
			.await
			.unwrap();

		let ack_pressure = next_tunnel_pressure(&mut sub).await;
		assert_eq!(ack_pressure.request_id, Some(request_id));
		assert_eq!(ack_pressure.pressure.queue_depth, 1);

		let tick_wave = next_tick_wave(&mut sub).await;
		assert_eq!(tick_wave.wave.frames.len(), 1);
		assert_eq!(
			tick_wave.wave.frames[0].sequence_range,
			protocol::mk2::SequenceRange { first: 1, last: 1 }
		);

		let messages = runner_gateway::wave_to_client_messages(&tick_wave.wave).unwrap();
		assert_eq!(messages.len(), 1);
		let protocol::mk2::ToClientTunnelMessageKind::ToClientWebSocketMessage(ws_msg) =
			&messages[0].message_kind
		else {
			panic!("expected websocket message");
		};
		assert_eq!(ws_msg.data, b"two".to_vec());
	}

	#[tokio::test]
	async fn tunnel_resume_control_closes_on_ack_newer_than_sent_tail() {
		let pubsub = memory_pubsub("pegboard-gateway-tunnel-resume-too-new");
		let state = SharedState::new(&test_config(), pubsub.clone());
		let receiver_subject = "runner-v8-resume-too-new".to_string();
		let mut sub = pubsub.subscribe(&receiver_subject).await.unwrap();
		let request_id = [41, 42, 43, 44];
		let _handle = state
			.start_in_flight_request(
				receiver_subject,
				PROTOCOL_MK2_VERSION,
				request_id,
				InFlightRequestState::ActiveWebSocket,
			)
			.await;
		state.toggle_hibernation(request_id, true).await.unwrap();

		state
			.send_messages(
				request_id,
				vec![websocket_message(b"one"), websocket_message(b"two")],
			)
			.await
			.unwrap();

		for _ in 0..2 {
			let wave = next_tick_wave(&mut sub).await;
			assert_eq!(wave.wave.backpressure, None);
		}
		let send_pressure = next_tunnel_pressure(&mut sub).await;
		assert_eq!(send_pressure.request_id, Some(request_id));
		assert_eq!(send_pressure.pressure.queue_depth, 2);

		state
			.recv_tunnel_control(protocol::mk2::ToServerTunnelControl {
				control: protocol::mk2::TunnelControl::TunnelResume(protocol::mk2::TunnelResume {
					gateway_id: state.gateway_id(),
					request_id,
					last_acked_seq: 99,
				}),
			})
			.await
			.unwrap();

		assert_next_resume_gap_close(&mut sub).await;
		let req = state
			.in_flight_requests
			.get_async(&request_id)
			.await
			.expect("request should still be tracked");
		let hibernation_state = req
			.hibernation_state
			.as_ref()
			.expect("hibernation should be enabled");
		assert_eq!(hibernation_state.pending_ws_msgs.len(), 2);
	}

	#[tokio::test]
	async fn tunnel_resume_control_closes_on_ack_older_than_pending_window() {
		let pubsub = memory_pubsub("pegboard-gateway-tunnel-resume-stale");
		let state = SharedState::new(&test_config(), pubsub.clone());
		let receiver_subject = "runner-v8-resume-stale".to_string();
		let mut sub = pubsub.subscribe(&receiver_subject).await.unwrap();
		let request_id = [45, 46, 47, 48];
		let _handle = state
			.start_in_flight_request(
				receiver_subject,
				PROTOCOL_MK2_VERSION,
				request_id,
				InFlightRequestState::ActiveWebSocket,
			)
			.await;
		state.toggle_hibernation(request_id, true).await.unwrap();

		state
			.send_messages(
				request_id,
				vec![
					websocket_message(b"one"),
					websocket_message(b"two"),
					websocket_message(b"three"),
				],
			)
			.await
			.unwrap();

		for _ in 0..3 {
			let wave = next_tick_wave(&mut sub).await;
			assert_eq!(wave.wave.backpressure, None);
		}
		let send_pressure = next_tunnel_pressure(&mut sub).await;
		assert_eq!(send_pressure.request_id, Some(request_id));
		assert_eq!(send_pressure.pressure.queue_depth, 3);

		state
			.recv_tunnel_control(protocol::mk2::ToServerTunnelControl {
				control: protocol::mk2::TunnelControl::TunnelAck(protocol::mk2::TunnelAck {
					gateway_id: state.gateway_id(),
					request_id,
					last_acked_seq: 1,
				}),
			})
			.await
			.unwrap();

		let ack_pressure = next_tunnel_pressure(&mut sub).await;
		assert_eq!(ack_pressure.request_id, Some(request_id));
		assert_eq!(ack_pressure.pressure.queue_depth, 1);

		state
			.recv_tunnel_control(protocol::mk2::ToServerTunnelControl {
				control: protocol::mk2::TunnelControl::TunnelResume(protocol::mk2::TunnelResume {
					gateway_id: state.gateway_id(),
					request_id,
					last_acked_seq: 0,
				}),
			})
			.await
			.unwrap();

		assert_next_resume_gap_close(&mut sub).await;
		let req = state
			.in_flight_requests
			.get_async(&request_id)
			.await
			.expect("request should still be tracked");
		let hibernation_state = req
			.hibernation_state
			.as_ref()
			.expect("hibernation should be enabled");
		assert_eq!(hibernation_state.pending_ws_msgs.len(), 1);
		assert_eq!(hibernation_state.pending_ws_msgs[0].message_index, 2);
	}

	#[tokio::test]
	async fn send_message_keeps_per_message_payload_for_protocol_v7() {
		let pubsub = memory_pubsub("pegboard-gateway-send-message-v7");
		let state = SharedState::new(&test_config(), pubsub.clone());
		let receiver_subject = "runner-v7".to_string();
		let mut sub = pubsub.subscribe(&receiver_subject).await.unwrap();
		let request_id = [5, 6, 7, 8];
		let _handle = state
			.start_in_flight_request(
				receiver_subject,
				PROTOCOL_MK2_VERSION - 1,
				request_id,
				InFlightRequestState::AwaitingHttpResponseStart,
			)
			.await;

		state
			.send_message(request_id, request_chunk_message())
			.await
			.unwrap();

		let msg = tokio::time::timeout(Duration::from_secs(1), sub.next())
			.await
			.unwrap()
			.unwrap();
		let NextOutput::Message(msg) = msg else {
			panic!("expected pubsub message");
		};
		let decoded = versioned::ToRunnerMk2::deserialize_with_embedded_version(&msg.payload)
			.expect("runner payload should decode");
		let protocol::mk2::ToRunner::ToClientTunnelMessage(message) = decoded else {
			panic!("expected legacy-compatible tunnel message");
		};
		assert_eq!(message.message_id.gateway_id, state.gateway_id());
		assert_eq!(message.message_id.request_id, request_id);
		assert!(matches!(
			message.message_kind,
			protocol::mk2::ToClientTunnelMessageKind::ToClientRequestChunk(_)
		));
	}
}

// fn wrapping_lt(a: u16, b: u16) -> bool {
//     b.wrapping_sub(a) < u16::MAX / 2
// }
