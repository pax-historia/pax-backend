use std::{collections::BTreeMap, error::Error, fmt};

use crate::{FabricConfig, GatewayId, ShardedReceiver, protocol};

const FAIR_DEMUX_SHARDS: usize = 64;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RunnerGatewayError {
	Encode(String),
	Decode(String),
	PayloadTooLarge {
		actual: usize,
		max: usize,
	},
	MultiMessageRange {
		first: u64,
		last: u64,
	},
	SequenceOutOfRange(u64),
	FrameKindMismatch {
		expected: protocol::TunnelFrameKind,
		actual: protocol::TunnelFrameKind,
	},
}

impl fmt::Display for RunnerGatewayError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Encode(err) => write!(f, "failed to encode tunnel message kind: {err}"),
			Self::Decode(err) => write!(f, "failed to decode tunnel frame bytes: {err}"),
			Self::PayloadTooLarge { actual, max } => {
				write!(f, "tunnel payload too large: actual={actual}, max={max}")
			}
			Self::MultiMessageRange { first, last } => write!(
				f,
				"per-message gateway adapter cannot represent sequence range {first}..={last}"
			),
			Self::SequenceOutOfRange(seq) => {
				write!(f, "message index cannot represent sequence {seq}")
			}
			Self::FrameKindMismatch { expected, actual } => write!(
				f,
				"tunnel frame kind mismatch: expected {expected:?}, got {actual:?}"
			),
		}
	}
}

impl Error for RunnerGatewayError {}

#[derive(Debug)]
pub struct RunnerToGatewayAdapter {
	max_payload_size: usize,
	next_epoch: BTreeMap<GatewayId, u64>,
}

#[derive(Debug)]
pub struct GatewayToRunnerAdapter {
	next_epoch: BTreeMap<GatewayId, u64>,
}

impl RunnerToGatewayAdapter {
	pub fn new(max_payload_size: usize) -> Self {
		Self {
			max_payload_size,
			next_epoch: BTreeMap::new(),
		}
	}

	pub fn build_waves(
		&mut self,
		messages: impl IntoIterator<Item = protocol::ToServerTunnelMessage>,
		backpressure: Option<protocol::Pressure>,
	) -> Result<Vec<protocol::TickWave>, RunnerGatewayError> {
		let mut gateway_order = Vec::<GatewayId>::new();
		let mut frames_by_gateway = BTreeMap::<GatewayId, Vec<protocol::TunnelFrame>>::new();

		for message in messages {
			let gateway_id = message.message_id.gateway_id;
			if !frames_by_gateway.contains_key(&gateway_id) {
				gateway_order.push(gateway_id);
			}

			frames_by_gateway
				.entry(gateway_id)
				.or_default()
				.push(message_to_frame(message, self.max_payload_size)?);
		}

		let mut waves = Vec::with_capacity(gateway_order.len());
		for gateway_id in gateway_order {
			let epoch = self.next_epoch.entry(gateway_id).or_insert(1);
			let frames = frames_by_gateway.remove(&gateway_id).unwrap_or_default();
			waves.push(protocol::TickWave {
				epoch: *epoch,
				gateway_id,
				frames,
				backpressure: backpressure.clone(),
			});
			*epoch += 1;
		}

		Ok(waves)
	}
}

impl GatewayToRunnerAdapter {
	pub fn new() -> Self {
		Self {
			next_epoch: BTreeMap::new(),
		}
	}

	pub fn build_waves(
		&mut self,
		messages: impl IntoIterator<Item = protocol::ToClientTunnelMessage>,
		backpressure: Option<protocol::Pressure>,
	) -> Result<Vec<protocol::TickWave>, RunnerGatewayError> {
		let mut gateway_order = Vec::<GatewayId>::new();
		let mut frames_by_gateway = BTreeMap::<GatewayId, Vec<protocol::TunnelFrame>>::new();

		for message in messages {
			let gateway_id = message.message_id.gateway_id;
			if !frames_by_gateway.contains_key(&gateway_id) {
				gateway_order.push(gateway_id);
			}

			frames_by_gateway
				.entry(gateway_id)
				.or_default()
				.push(client_message_to_frame(message)?);
		}

		let mut waves = Vec::with_capacity(gateway_order.len());
		for gateway_id in gateway_order {
			let epoch = self.next_epoch.entry(gateway_id).or_insert(1);
			let frames = frames_by_gateway.remove(&gateway_id).unwrap_or_default();
			waves.push(protocol::TickWave {
				epoch: *epoch,
				gateway_id,
				frames,
				backpressure: backpressure.clone(),
			});
			*epoch += 1;
		}

		Ok(waves)
	}
}

pub fn message_to_frame(
	message: protocol::ToServerTunnelMessage,
	max_payload_size: usize,
) -> Result<protocol::TunnelFrame, RunnerGatewayError> {
	let inner_data_len = tunnel_message_inner_data_len(&message.message_kind);
	if inner_data_len > max_payload_size {
		return Err(RunnerGatewayError::PayloadTooLarge {
			actual: inner_data_len,
			max: max_payload_size,
		});
	}

	let message_kind = message_kind_frame_kind(&message.message_kind);
	let bytes = serde_bare::to_vec(&message.message_kind)
		.map_err(|err| RunnerGatewayError::Encode(err.to_string()))?;
	let seq = u64::from(message.message_id.message_index);

	Ok(protocol::TunnelFrame {
		request_id: message.message_id.request_id,
		sequence_range: protocol::SequenceRange {
			first: seq,
			last: seq,
		},
		message_kind,
		bytes,
	})
}

pub fn client_message_to_frame(
	message: protocol::ToClientTunnelMessage,
) -> Result<protocol::TunnelFrame, RunnerGatewayError> {
	let message_kind = client_message_kind_frame_kind(&message.message_kind);
	let bytes = serde_bare::to_vec(&message.message_kind)
		.map_err(|err| RunnerGatewayError::Encode(err.to_string()))?;
	let seq = u64::from(message.message_id.message_index);

	Ok(protocol::TunnelFrame {
		request_id: message.message_id.request_id,
		sequence_range: protocol::SequenceRange {
			first: seq,
			last: seq,
		},
		message_kind,
		bytes,
	})
}

pub fn wave_to_tunnel_messages(
	wave: &protocol::TickWave,
) -> Result<Vec<protocol::ToServerTunnelMessage>, RunnerGatewayError> {
	wave.frames
		.iter()
		.map(|frame| frame_to_message(wave.gateway_id, frame))
		.collect()
}

pub fn wave_to_tunnel_messages_fair(
	wave: &protocol::TickWave,
) -> Result<Vec<protocol::ToServerTunnelMessage>, RunnerGatewayError> {
	fair_ordered_frames(wave)
		.iter()
		.map(|frame| frame_to_message(wave.gateway_id, frame))
		.collect()
}

pub fn frame_to_message(
	gateway_id: GatewayId,
	frame: &protocol::TunnelFrame,
) -> Result<protocol::ToServerTunnelMessage, RunnerGatewayError> {
	let message_kind = serde_bare::from_slice::<protocol::ToServerTunnelMessageKind>(&frame.bytes)
		.map_err(|err| RunnerGatewayError::Decode(err.to_string()))?;
	let expected = message_kind_frame_kind(&message_kind);
	validate_frame_kind(frame, expected)?;

	Ok(protocol::ToServerTunnelMessage {
		message_id: message_id_from_frame(gateway_id, frame)?,
		message_kind,
	})
}

pub fn wave_to_client_messages(
	wave: &protocol::TickWave,
) -> Result<Vec<protocol::ToClientTunnelMessage>, RunnerGatewayError> {
	wave.frames
		.iter()
		.map(|frame| client_frame_to_message(wave.gateway_id, frame))
		.collect()
}

pub fn wave_to_client_messages_fair(
	wave: &protocol::TickWave,
) -> Result<Vec<protocol::ToClientTunnelMessage>, RunnerGatewayError> {
	fair_ordered_frames(wave)
		.iter()
		.map(|frame| client_frame_to_message(wave.gateway_id, frame))
		.collect()
}

pub fn client_frame_to_message(
	gateway_id: GatewayId,
	frame: &protocol::TunnelFrame,
) -> Result<protocol::ToClientTunnelMessage, RunnerGatewayError> {
	let message_kind = serde_bare::from_slice::<protocol::ToClientTunnelMessageKind>(&frame.bytes)
		.map_err(|err| RunnerGatewayError::Decode(err.to_string()))?;
	let expected = client_message_kind_frame_kind(&message_kind);
	validate_frame_kind(frame, expected)?;

	Ok(protocol::ToClientTunnelMessage {
		message_id: message_id_from_frame(gateway_id, frame)?,
		message_kind,
	})
}

fn fair_ordered_frames(wave: &protocol::TickWave) -> Vec<protocol::TunnelFrame> {
	let capacity = wave.frames.len().max(1);
	let mut receiver = ShardedReceiver::new(FabricConfig::new(FAIR_DEMUX_SHARDS, capacity));
	receiver.enqueue_wave(wave);
	receiver
		.drain_ready(wave.frames.len())
		.into_iter()
		.map(|delivered| delivered.frame)
		.collect()
}

pub fn should_clear_route(message_kind: &protocol::ToServerTunnelMessageKind) -> bool {
	match message_kind {
		protocol::ToServerTunnelMessageKind::ToServerResponseStart(response) => !response.stream,
		protocol::ToServerTunnelMessageKind::ToServerResponseChunk(chunk) => chunk.finish,
		protocol::ToServerTunnelMessageKind::ToServerResponseAbort => true,
		protocol::ToServerTunnelMessageKind::ToServerWebSocketClose(close) => !close.hibernate,
		_ => false,
	}
}

pub fn tunnel_message_inner_data_len(message_kind: &protocol::ToServerTunnelMessageKind) -> usize {
	match message_kind {
		protocol::ToServerTunnelMessageKind::ToServerResponseStart(resp) => {
			resp.body.as_ref().map_or(0, |body| body.len())
		}
		protocol::ToServerTunnelMessageKind::ToServerResponseChunk(chunk) => chunk.body.len(),
		protocol::ToServerTunnelMessageKind::ToServerWebSocketMessage(msg) => msg.data.len(),
		protocol::ToServerTunnelMessageKind::ToServerResponseAbort
		| protocol::ToServerTunnelMessageKind::ToServerWebSocketOpen(_)
		| protocol::ToServerTunnelMessageKind::ToServerWebSocketMessageAck(_)
		| protocol::ToServerTunnelMessageKind::ToServerWebSocketClose(_) => 0,
	}
}

fn message_kind_frame_kind(
	message_kind: &protocol::ToServerTunnelMessageKind,
) -> protocol::TunnelFrameKind {
	match message_kind {
		protocol::ToServerTunnelMessageKind::ToServerResponseStart(_)
		| protocol::ToServerTunnelMessageKind::ToServerResponseChunk(_)
		| protocol::ToServerTunnelMessageKind::ToServerResponseAbort => protocol::TunnelFrameKind::Http,
		protocol::ToServerTunnelMessageKind::ToServerWebSocketOpen(_)
		| protocol::ToServerTunnelMessageKind::ToServerWebSocketMessage(_)
		| protocol::ToServerTunnelMessageKind::ToServerWebSocketMessageAck(_)
		| protocol::ToServerTunnelMessageKind::ToServerWebSocketClose(_) => {
			protocol::TunnelFrameKind::WebSocket
		}
	}
}

fn client_message_kind_frame_kind(
	message_kind: &protocol::ToClientTunnelMessageKind,
) -> protocol::TunnelFrameKind {
	match message_kind {
		protocol::ToClientTunnelMessageKind::ToClientRequestStart(_)
		| protocol::ToClientTunnelMessageKind::ToClientRequestChunk(_)
		| protocol::ToClientTunnelMessageKind::ToClientRequestAbort => protocol::TunnelFrameKind::Http,
		protocol::ToClientTunnelMessageKind::ToClientWebSocketOpen(_)
		| protocol::ToClientTunnelMessageKind::ToClientWebSocketMessage(_)
		| protocol::ToClientTunnelMessageKind::ToClientWebSocketClose(_) => {
			protocol::TunnelFrameKind::WebSocket
		}
	}
}

fn validate_frame_kind(
	frame: &protocol::TunnelFrame,
	expected: protocol::TunnelFrameKind,
) -> Result<(), RunnerGatewayError> {
	if frame.message_kind != expected {
		return Err(RunnerGatewayError::FrameKindMismatch {
			expected,
			actual: frame.message_kind.clone(),
		});
	}

	Ok(())
}

fn message_id_from_frame(
	gateway_id: GatewayId,
	frame: &protocol::TunnelFrame,
) -> Result<protocol::MessageId, RunnerGatewayError> {
	let seq = frame.sequence_range.first;
	if frame.sequence_range.last != seq {
		return Err(RunnerGatewayError::MultiMessageRange {
			first: frame.sequence_range.first,
			last: frame.sequence_range.last,
		});
	}

	let message_index =
		u16::try_from(seq).map_err(|_| RunnerGatewayError::SequenceOutOfRange(seq))?;

	Ok(protocol::MessageId {
		gateway_id,
		request_id: frame.request_id,
		message_index,
	})
}
