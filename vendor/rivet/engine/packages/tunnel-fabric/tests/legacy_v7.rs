use rivet_runner_protocol::generated::v7;
use tunnel_fabric::{legacy, protocol};

const GATEWAY: [u8; 4] = [1, 2, 3, 4];
const REQUEST: [u8; 4] = [5, 6, 7, 8];

fn server_ws_message(index: u16) -> v7::ToServerTunnelMessage {
	v7::ToServerTunnelMessage {
		message_id: v7::MessageId {
			gateway_id: GATEWAY,
			request_id: REQUEST,
			message_index: index,
		},
		message_kind: v7::ToServerTunnelMessageKind::ToServerWebSocketMessage(
			v7::ToServerWebSocketMessage {
				data: b"runner-to-gateway".to_vec(),
				binary: true,
			},
		),
	}
}

fn client_http_message(index: u16) -> v7::ToClientTunnelMessage {
	v7::ToClientTunnelMessage {
		message_id: v7::MessageId {
			gateway_id: GATEWAY,
			request_id: REQUEST,
			message_index: index,
		},
		message_kind: v7::ToClientTunnelMessageKind::ToClientRequestChunk(
			v7::ToClientRequestChunk {
				body: b"gateway-to-runner".to_vec(),
				finish: false,
			},
		),
	}
}

#[test]
fn server_legacy_message_round_trips_through_single_frame_wave() {
	let message = server_ws_message(7);

	let wave = legacy::to_server_message_to_wave(11, message.clone()).unwrap();
	let decoded = legacy::wave_to_server_messages(&wave).unwrap();

	assert_eq!(wave.epoch, 11);
	assert_eq!(wave.gateway_id, GATEWAY);
	assert_eq!(wave.frames[0].request_id, REQUEST);
	assert_eq!(
		wave.frames[0].sequence_range,
		protocol::SequenceRange { first: 7, last: 7 }
	);
	assert_eq!(
		wave.frames[0].message_kind,
		protocol::TunnelFrameKind::WebSocket
	);
	assert_eq!(decoded, vec![message]);
}

#[test]
fn client_legacy_message_round_trips_through_single_frame_wave() {
	let message = client_http_message(9);

	let wave = legacy::to_client_message_to_wave(12, message.clone()).unwrap();
	let decoded = legacy::wave_to_client_messages(&wave).unwrap();

	assert_eq!(wave.frames[0].message_kind, protocol::TunnelFrameKind::Http);
	assert_eq!(decoded, vec![message]);
}

#[test]
fn multi_sequence_tickwave_frame_rejects_v7_decode() {
	let mut wave = legacy::to_server_message_to_wave(11, server_ws_message(7)).unwrap();
	wave.frames[0].sequence_range.last = 8;

	let err = legacy::wave_to_server_messages(&wave).unwrap_err();

	assert_eq!(
		err,
		legacy::LegacyShimError::MultiMessageRange { first: 7, last: 8 }
	);
}

#[test]
fn frame_kind_mismatch_rejects_v7_decode() {
	let mut wave = legacy::to_server_message_to_wave(11, server_ws_message(7)).unwrap();
	wave.frames[0].message_kind = protocol::TunnelFrameKind::Http;

	let err = legacy::wave_to_server_messages(&wave).unwrap_err();

	assert_eq!(
		err,
		legacy::LegacyShimError::FrameKindMismatch {
			expected: protocol::TunnelFrameKind::WebSocket,
			actual: protocol::TunnelFrameKind::Http,
		}
	);
}
