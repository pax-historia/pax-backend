use std::sync::Arc;
use std::time::Duration;

use tunnel_fabric::{
	FabricConfig, ShardedReceiver, protocol,
	runner_gateway::{self, GatewayToRunnerAdapter, RunnerGatewayError, RunnerToGatewayAdapter},
	ups::UpsWaveLane,
	ups_lane_spec,
};
use universalpubsub::{PubSub, driver::memory::MemoryDriver};

const GATEWAY_A: [u8; 4] = [1, 1, 1, 1];
const GATEWAY_B: [u8; 4] = [2, 2, 2, 2];
const REQ_A: [u8; 4] = [10, 0, 0, 0];
const REQ_B: [u8; 4] = [20, 0, 0, 0];

fn ws_message(
	gateway_id: [u8; 4],
	request_id: [u8; 4],
	message_index: u16,
	bytes: &'static [u8],
) -> protocol::ToServerTunnelMessage {
	protocol::ToServerTunnelMessage {
		message_id: protocol::MessageId {
			gateway_id,
			request_id,
			message_index,
		},
		message_kind: protocol::ToServerTunnelMessageKind::ToServerWebSocketMessage(
			protocol::ToServerWebSocketMessage {
				data: bytes.to_vec(),
				binary: true,
			},
		),
	}
}

fn http_chunk(
	gateway_id: [u8; 4],
	request_id: [u8; 4],
	message_index: u16,
	finish: bool,
) -> protocol::ToServerTunnelMessage {
	protocol::ToServerTunnelMessage {
		message_id: protocol::MessageId {
			gateway_id,
			request_id,
			message_index,
		},
		message_kind: protocol::ToServerTunnelMessageKind::ToServerResponseChunk(
			protocol::ToServerResponseChunk {
				body: b"chunk".to_vec(),
				finish,
			},
		),
	}
}

fn client_ws_message(
	gateway_id: [u8; 4],
	request_id: [u8; 4],
	message_index: u16,
	bytes: &'static [u8],
) -> protocol::ToClientTunnelMessage {
	protocol::ToClientTunnelMessage {
		message_id: protocol::MessageId {
			gateway_id,
			request_id,
			message_index,
		},
		message_kind: protocol::ToClientTunnelMessageKind::ToClientWebSocketMessage(
			protocol::ToClientWebSocketMessage {
				data: bytes.to_vec(),
				binary: true,
			},
		),
	}
}

fn client_http_chunk(
	gateway_id: [u8; 4],
	request_id: [u8; 4],
	message_index: u16,
	finish: bool,
) -> protocol::ToClientTunnelMessage {
	protocol::ToClientTunnelMessage {
		message_id: protocol::MessageId {
			gateway_id,
			request_id,
			message_index,
		},
		message_kind: protocol::ToClientTunnelMessageKind::ToClientRequestChunk(
			protocol::ToClientRequestChunk {
				body: b"chunk".to_vec(),
				finish,
			},
		),
	}
}

#[test]
fn batches_existing_tunnel_messages_by_gateway() {
	let mut adapter = RunnerToGatewayAdapter::new(1024);
	let a1 = ws_message(GATEWAY_A, REQ_A, 7, b"a1");
	let b1 = ws_message(GATEWAY_B, REQ_A, 3, b"b1");
	let a2 = http_chunk(GATEWAY_A, REQ_B, 9, false);

	let waves = adapter
		.build_waves([a1.clone(), b1.clone(), a2.clone()], None)
		.unwrap();

	assert_eq!(waves.len(), 2);
	assert_eq!(waves[0].gateway_id, GATEWAY_A);
	assert_eq!(waves[0].epoch, 1);
	assert_eq!(waves[0].frames.len(), 2);
	assert_eq!(
		waves[0].frames[0].sequence_range,
		protocol::SequenceRange { first: 7, last: 7 }
	);
	assert_eq!(
		waves[0].frames[1].message_kind,
		protocol::TunnelFrameKind::Http
	);
	assert_eq!(waves[1].gateway_id, GATEWAY_B);
	assert_eq!(waves[1].epoch, 1);

	assert_eq!(
		runner_gateway::wave_to_tunnel_messages(&waves[0]).unwrap(),
		vec![a1, a2]
	);
	assert_eq!(
		runner_gateway::wave_to_tunnel_messages(&waves[1]).unwrap(),
		vec![b1]
	);
}

#[test]
fn batches_gateway_client_messages_by_gateway() {
	let mut adapter = GatewayToRunnerAdapter::new();
	let a1 = client_ws_message(GATEWAY_A, REQ_A, 7, b"a1");
	let b1 = client_ws_message(GATEWAY_B, REQ_A, 3, b"b1");
	let a2 = client_http_chunk(GATEWAY_A, REQ_B, 9, false);

	let waves = adapter
		.build_waves([a1.clone(), b1.clone(), a2.clone()], None)
		.unwrap();

	assert_eq!(waves.len(), 2);
	assert_eq!(waves[0].gateway_id, GATEWAY_A);
	assert_eq!(waves[0].epoch, 1);
	assert_eq!(waves[0].frames.len(), 2);
	assert_eq!(
		waves[0].frames[0].sequence_range,
		protocol::SequenceRange { first: 7, last: 7 }
	);
	assert_eq!(
		waves[0].frames[1].message_kind,
		protocol::TunnelFrameKind::Http
	);
	assert_eq!(waves[1].gateway_id, GATEWAY_B);
	assert_eq!(waves[1].epoch, 1);

	assert_eq!(
		runner_gateway::wave_to_client_messages(&waves[0]).unwrap(),
		vec![a1, a2]
	);
	assert_eq!(
		runner_gateway::wave_to_client_messages(&waves[1]).unwrap(),
		vec![b1]
	);
}

#[test]
fn fair_gateway_decode_round_robins_requests() {
	let mut adapter = RunnerToGatewayAdapter::new(1024);
	let messages = [
		ws_message(GATEWAY_A, REQ_A, 1, b"a1"),
		ws_message(GATEWAY_A, REQ_A, 2, b"a2"),
		ws_message(GATEWAY_A, REQ_B, 1, b"b1"),
		ws_message(GATEWAY_A, REQ_B, 2, b"b2"),
	];

	let wave = adapter
		.build_waves(messages.clone(), None)
		.unwrap()
		.remove(0);

	assert_eq!(
		runner_gateway::wave_to_tunnel_messages(&wave).unwrap(),
		messages
	);
	assert_eq!(
		runner_gateway::wave_to_tunnel_messages_fair(&wave).unwrap(),
		vec![
			messages[0].clone(),
			messages[2].clone(),
			messages[1].clone(),
			messages[3].clone(),
		]
	);
}

#[test]
fn fair_client_decode_round_robins_requests() {
	let mut adapter = GatewayToRunnerAdapter::new();
	let messages = [
		client_ws_message(GATEWAY_A, REQ_A, 1, b"a1"),
		client_ws_message(GATEWAY_A, REQ_A, 2, b"a2"),
		client_ws_message(GATEWAY_A, REQ_B, 1, b"b1"),
		client_ws_message(GATEWAY_A, REQ_B, 2, b"b2"),
	];

	let wave = adapter
		.build_waves(messages.clone(), None)
		.unwrap()
		.remove(0);

	assert_eq!(
		runner_gateway::wave_to_client_messages(&wave).unwrap(),
		messages
	);
	assert_eq!(
		runner_gateway::wave_to_client_messages_fair(&wave).unwrap(),
		vec![
			messages[0].clone(),
			messages[2].clone(),
			messages[1].clone(),
			messages[3].clone(),
		]
	);
}

#[test]
fn gateway_epochs_are_monotonic_per_gateway() {
	let mut adapter = RunnerToGatewayAdapter::new(1024);

	let first = adapter
		.build_waves([ws_message(GATEWAY_A, REQ_A, 1, b"a1")], None)
		.unwrap();
	let second = adapter
		.build_waves([ws_message(GATEWAY_A, REQ_A, 2, b"a2")], None)
		.unwrap();
	let other = adapter
		.build_waves([ws_message(GATEWAY_B, REQ_A, 1, b"b1")], None)
		.unwrap();

	assert_eq!(first[0].epoch, 1);
	assert_eq!(second[0].epoch, 2);
	assert_eq!(other[0].epoch, 1);
}

#[test]
fn runner_epochs_are_monotonic_per_gateway() {
	let mut adapter = GatewayToRunnerAdapter::new();

	let first = adapter
		.build_waves([client_ws_message(GATEWAY_A, REQ_A, 1, b"a1")], None)
		.unwrap();
	let second = adapter
		.build_waves([client_ws_message(GATEWAY_A, REQ_A, 2, b"a2")], None)
		.unwrap();
	let other = adapter
		.build_waves([client_ws_message(GATEWAY_B, REQ_A, 1, b"b1")], None)
		.unwrap();

	assert_eq!(first[0].epoch, 1);
	assert_eq!(second[0].epoch, 2);
	assert_eq!(other[0].epoch, 1);
}

#[test]
fn rejects_payloads_over_runner_limit() {
	let mut adapter = RunnerToGatewayAdapter::new(3);

	let err = adapter
		.build_waves([ws_message(GATEWAY_A, REQ_A, 1, b"too-large")], None)
		.unwrap_err();

	assert_eq!(
		err,
		RunnerGatewayError::PayloadTooLarge { actual: 9, max: 3 }
	);
}

#[test]
fn v8_only_sequence_ranges_do_not_decode_as_per_message_gateway_payloads() {
	let mut adapter = RunnerToGatewayAdapter::new(1024);
	let mut wave = adapter
		.build_waves([ws_message(GATEWAY_A, REQ_A, 7, b"a1")], None)
		.unwrap()
		.remove(0);
	wave.frames[0].sequence_range.last = 8;

	let err = runner_gateway::wave_to_tunnel_messages(&wave).unwrap_err();

	assert_eq!(
		err,
		RunnerGatewayError::MultiMessageRange { first: 7, last: 8 }
	);
}

#[test]
fn v8_only_sequence_ranges_do_not_decode_as_per_message_runner_payloads() {
	let mut adapter = GatewayToRunnerAdapter::new();
	let mut wave = adapter
		.build_waves([client_ws_message(GATEWAY_A, REQ_A, 7, b"a1")], None)
		.unwrap()
		.remove(0);
	wave.frames[0].sequence_range.last = 8;

	let err = runner_gateway::wave_to_client_messages(&wave).unwrap_err();

	assert_eq!(
		err,
		RunnerGatewayError::MultiMessageRange { first: 7, last: 8 }
	);
}

#[test]
fn route_clear_policy_matches_existing_tunnel_semantics() {
	assert!(runner_gateway::should_clear_route(
		&http_chunk(GATEWAY_A, REQ_A, 1, true).message_kind
	));
	assert!(!runner_gateway::should_clear_route(
		&http_chunk(GATEWAY_A, REQ_A, 1, false).message_kind
	));
	assert!(runner_gateway::should_clear_route(
		&protocol::ToServerTunnelMessageKind::ToServerWebSocketClose(
			protocol::ToServerWebSocketClose {
				code: Some(1000),
				reason: None,
				hibernate: false,
			},
		)
	));
	assert!(!runner_gateway::should_clear_route(
		&protocol::ToServerTunnelMessageKind::ToServerWebSocketClose(
			protocol::ToServerWebSocketClose {
				code: Some(1001),
				reason: Some("hibernate".to_string()),
				hibernate: true,
			},
		)
	));
}

#[tokio::test]
async fn adapter_waves_publish_through_ups_and_feed_receiver() {
	let pubsub = PubSub::new(Arc::new(MemoryDriver::new(
		"runner-gateway-adapter".to_string(),
	)));
	let lane = pubsub
		.named_lane("tunnel-v2", ups_lane_spec(16))
		.expect("lane should build");
	let ups = UpsWaveLane::new(lane);
	let mut subscriber = ups
		.subscribe_gateway(GATEWAY_A)
		.await
		.expect("gateway subscriber should build");
	let mut receiver = ShardedReceiver::new(FabricConfig::new(2, 8));
	let mut adapter = RunnerToGatewayAdapter::new(1024);
	let messages = [
		ws_message(GATEWAY_A, REQ_A, 1, b"a1"),
		ws_message(GATEWAY_A, REQ_B, 1, b"a2"),
	];

	let waves = adapter.build_waves(messages.clone(), None).unwrap();
	assert_eq!(waves.len(), 1);
	ups.publish_wave(&waves[0])
		.await
		.expect("wave should publish");
	tokio::time::timeout(
		Duration::from_secs(1),
		subscriber.next_into_receiver(&mut receiver),
	)
	.await
	.expect("subscriber should receive wave")
	.expect("subscriber should enqueue wave")
	.expect("subscriber should not close");

	let delivered = receiver.drain_ready(2);
	let decoded = delivered
		.iter()
		.map(|delivered| runner_gateway::frame_to_message(GATEWAY_A, &delivered.frame))
		.collect::<Result<Vec<_>, _>>()
		.unwrap();

	assert_eq!(decoded, messages);
}
