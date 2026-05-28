use std::{error::Error, fmt};

use rivet_runner_protocol::generated::v7;

use crate::{GatewayId, protocol};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LegacyShimError {
	Encode(String),
	Decode(String),
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

impl fmt::Display for LegacyShimError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Encode(err) => write!(f, "failed to encode legacy tunnel message: {err}"),
			Self::Decode(err) => write!(f, "failed to decode legacy tunnel message: {err}"),
			Self::MultiMessageRange { first, last } => write!(
				f,
				"legacy tunnel message cannot represent sequence range {first}..={last}"
			),
			Self::SequenceOutOfRange(seq) => {
				write!(f, "legacy message index cannot represent sequence {seq}")
			}
			Self::FrameKindMismatch { expected, actual } => write!(
				f,
				"legacy tunnel frame kind mismatch: expected {expected:?}, got {actual:?}"
			),
		}
	}
}

impl Error for LegacyShimError {}

pub fn to_server_message_to_wave(
	epoch: u64,
	message: v7::ToServerTunnelMessage,
) -> Result<protocol::TickWave, LegacyShimError> {
	let frame_kind = to_server_frame_kind(&message.message_kind);
	let bytes = serde_bare::to_vec(&message.message_kind)
		.map_err(|err| LegacyShimError::Encode(err.to_string()))?;

	Ok(single_frame_wave(
		epoch,
		message.message_id.gateway_id,
		message.message_id.request_id,
		message.message_id.message_index,
		frame_kind,
		bytes,
	))
}

pub fn to_client_message_to_wave(
	epoch: u64,
	message: v7::ToClientTunnelMessage,
) -> Result<protocol::TickWave, LegacyShimError> {
	let frame_kind = to_client_frame_kind(&message.message_kind);
	let bytes = serde_bare::to_vec(&message.message_kind)
		.map_err(|err| LegacyShimError::Encode(err.to_string()))?;

	Ok(single_frame_wave(
		epoch,
		message.message_id.gateway_id,
		message.message_id.request_id,
		message.message_id.message_index,
		frame_kind,
		bytes,
	))
}

pub fn wave_to_server_messages(
	wave: &protocol::TickWave,
) -> Result<Vec<v7::ToServerTunnelMessage>, LegacyShimError> {
	wave.frames
		.iter()
		.map(|frame| {
			let message_kind =
				serde_bare::from_slice::<v7::ToServerTunnelMessageKind>(&frame.bytes)
					.map_err(|err| LegacyShimError::Decode(err.to_string()))?;
			let expected = to_server_frame_kind(&message_kind);
			validate_legacy_frame(frame, expected)?;

			Ok(v7::ToServerTunnelMessage {
				message_id: legacy_message_id(wave.gateway_id, frame)?,
				message_kind,
			})
		})
		.collect()
}

pub fn wave_to_client_messages(
	wave: &protocol::TickWave,
) -> Result<Vec<v7::ToClientTunnelMessage>, LegacyShimError> {
	wave.frames
		.iter()
		.map(|frame| {
			let message_kind =
				serde_bare::from_slice::<v7::ToClientTunnelMessageKind>(&frame.bytes)
					.map_err(|err| LegacyShimError::Decode(err.to_string()))?;
			let expected = to_client_frame_kind(&message_kind);
			validate_legacy_frame(frame, expected)?;

			Ok(v7::ToClientTunnelMessage {
				message_id: legacy_message_id(wave.gateway_id, frame)?,
				message_kind,
			})
		})
		.collect()
}

fn single_frame_wave(
	epoch: u64,
	gateway_id: GatewayId,
	request_id: v7::RequestId,
	message_index: v7::MessageIndex,
	message_kind: protocol::TunnelFrameKind,
	bytes: Vec<u8>,
) -> protocol::TickWave {
	let seq = u64::from(message_index);
	protocol::TickWave {
		epoch,
		gateway_id,
		frames: vec![protocol::TunnelFrame {
			request_id,
			sequence_range: protocol::SequenceRange {
				first: seq,
				last: seq,
			},
			message_kind,
			bytes,
		}],
		backpressure: None,
	}
}

fn legacy_message_id(
	gateway_id: GatewayId,
	frame: &protocol::TunnelFrame,
) -> Result<v7::MessageId, LegacyShimError> {
	let seq = frame.sequence_range.first;
	if frame.sequence_range.last != seq {
		return Err(LegacyShimError::MultiMessageRange {
			first: frame.sequence_range.first,
			last: frame.sequence_range.last,
		});
	}

	let message_index = u16::try_from(seq).map_err(|_| LegacyShimError::SequenceOutOfRange(seq))?;

	Ok(v7::MessageId {
		gateway_id,
		request_id: frame.request_id,
		message_index,
	})
}

fn validate_legacy_frame(
	frame: &protocol::TunnelFrame,
	expected: protocol::TunnelFrameKind,
) -> Result<(), LegacyShimError> {
	if frame.message_kind != expected {
		return Err(LegacyShimError::FrameKindMismatch {
			expected,
			actual: frame.message_kind.clone(),
		});
	}

	Ok(())
}

fn to_server_frame_kind(message_kind: &v7::ToServerTunnelMessageKind) -> protocol::TunnelFrameKind {
	match message_kind {
		v7::ToServerTunnelMessageKind::ToServerResponseStart(_)
		| v7::ToServerTunnelMessageKind::ToServerResponseChunk(_)
		| v7::ToServerTunnelMessageKind::ToServerResponseAbort => protocol::TunnelFrameKind::Http,
		v7::ToServerTunnelMessageKind::ToServerWebSocketOpen(_)
		| v7::ToServerTunnelMessageKind::ToServerWebSocketMessage(_)
		| v7::ToServerTunnelMessageKind::ToServerWebSocketMessageAck(_)
		| v7::ToServerTunnelMessageKind::ToServerWebSocketClose(_) => {
			protocol::TunnelFrameKind::WebSocket
		}
	}
}

fn to_client_frame_kind(message_kind: &v7::ToClientTunnelMessageKind) -> protocol::TunnelFrameKind {
	match message_kind {
		v7::ToClientTunnelMessageKind::ToClientRequestStart(_)
		| v7::ToClientTunnelMessageKind::ToClientRequestChunk(_)
		| v7::ToClientTunnelMessageKind::ToClientRequestAbort => protocol::TunnelFrameKind::Http,
		v7::ToClientTunnelMessageKind::ToClientWebSocketOpen(_)
		| v7::ToClientTunnelMessageKind::ToClientWebSocketMessage(_)
		| v7::ToClientTunnelMessageKind::ToClientWebSocketClose(_) => {
			protocol::TunnelFrameKind::WebSocket
		}
	}
}
