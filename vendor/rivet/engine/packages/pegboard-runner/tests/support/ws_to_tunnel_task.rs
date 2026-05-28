use std::{sync::Arc, time::Duration};

use pegboard::pubsub_subjects::GatewayReceiverSubject;
use rivet_runner_protocol as protocol;
use scc::HashMap;
use tokio::sync::Mutex;
use tunnel_fabric::runner_gateway::RunnerToGatewayAdapter;
use universalpubsub::{NextOutput, PubSub, driver::memory::MemoryDriver};
use vbare::OwnedVersionedData;

use super::{handle_tunnel_control_mk2, handle_tunnel_message_mk1, handle_tunnel_message_mk2};

fn memory_pubsub(channel: &str) -> PubSub {
	PubSub::new(Arc::new(MemoryDriver::new(channel.to_string())))
}

fn tunnel_v2_adapter() -> Mutex<RunnerToGatewayAdapter> {
	Mutex::new(RunnerToGatewayAdapter::new(1024))
}

fn response_abort_message_mk2(
	gateway_id: protocol::mk2::GatewayId,
	request_id: protocol::mk2::RequestId,
) -> protocol::mk2::ToServerTunnelMessage {
	protocol::mk2::ToServerTunnelMessage {
		message_id: protocol::mk2::MessageId {
			gateway_id,
			request_id,
			message_index: 0,
		},
		message_kind: protocol::mk2::ToServerTunnelMessageKind::ToServerResponseAbort,
	}
}

fn response_start_message_mk2(
	gateway_id: protocol::mk2::GatewayId,
	request_id: protocol::mk2::RequestId,
) -> protocol::mk2::ToServerTunnelMessage {
	response_start_message_mk2_with_stream(gateway_id, request_id, false)
}

fn response_start_message_mk2_with_stream(
	gateway_id: protocol::mk2::GatewayId,
	request_id: protocol::mk2::RequestId,
	stream: bool,
) -> protocol::mk2::ToServerTunnelMessage {
	protocol::mk2::ToServerTunnelMessage {
		message_id: protocol::mk2::MessageId {
			gateway_id,
			request_id,
			message_index: 0,
		},
		message_kind: protocol::mk2::ToServerTunnelMessageKind::ToServerResponseStart(
			protocol::mk2::ToServerResponseStart {
				status: 200,
				headers: Default::default(),
				body: None,
				stream,
			},
		),
	}
}

fn response_chunk_message_mk2(
	gateway_id: protocol::mk2::GatewayId,
	request_id: protocol::mk2::RequestId,
	finish: bool,
) -> protocol::mk2::ToServerTunnelMessage {
	protocol::mk2::ToServerTunnelMessage {
		message_id: protocol::mk2::MessageId {
			gateway_id,
			request_id,
			message_index: 0,
		},
		message_kind: protocol::mk2::ToServerTunnelMessageKind::ToServerResponseChunk(
			protocol::mk2::ToServerResponseChunk {
				body: b"chunk".to_vec(),
				finish,
			},
		),
	}
}

fn websocket_message_mk2(
	gateway_id: protocol::mk2::GatewayId,
	request_id: protocol::mk2::RequestId,
) -> protocol::mk2::ToServerTunnelMessage {
	protocol::mk2::ToServerTunnelMessage {
		message_id: protocol::mk2::MessageId {
			gateway_id,
			request_id,
			message_index: 0,
		},
		message_kind: protocol::mk2::ToServerTunnelMessageKind::ToServerWebSocketMessage(
			protocol::mk2::ToServerWebSocketMessage {
				data: b"ping".to_vec(),
				binary: false,
			},
		),
	}
}

fn response_abort_message_mk1(
	gateway_id: protocol::mk2::GatewayId,
	request_id: protocol::mk2::RequestId,
) -> protocol::ToServerTunnelMessage {
	protocol::ToServerTunnelMessage {
		message_id: protocol::MessageId {
			gateway_id,
			request_id,
			message_index: 0,
		},
		message_kind: protocol::ToServerTunnelMessageKind::ToServerResponseAbort,
	}
}

fn websocket_message_mk1(
	gateway_id: protocol::mk2::GatewayId,
	request_id: protocol::mk2::RequestId,
) -> protocol::ToServerTunnelMessage {
	protocol::ToServerTunnelMessage {
		message_id: protocol::MessageId {
			gateway_id,
			request_id,
			message_index: 0,
		},
		message_kind: protocol::ToServerTunnelMessageKind::ToServerWebSocketMessage(
			protocol::ToServerWebSocketMessage {
				data: b"ping".to_vec(),
				binary: false,
			},
		),
	}
}

fn response_start_message_mk1(
	gateway_id: protocol::mk2::GatewayId,
	request_id: protocol::mk2::RequestId,
) -> protocol::ToServerTunnelMessage {
	response_start_message_mk1_with_stream(gateway_id, request_id, false)
}

fn response_start_message_mk1_with_stream(
	gateway_id: protocol::mk2::GatewayId,
	request_id: protocol::mk2::RequestId,
	stream: bool,
) -> protocol::ToServerTunnelMessage {
	protocol::ToServerTunnelMessage {
		message_id: protocol::MessageId {
			gateway_id,
			request_id,
			message_index: 0,
		},
		message_kind: protocol::ToServerTunnelMessageKind::ToServerResponseStart(
			protocol::ToServerResponseStart {
				status: 200,
				headers: Default::default(),
				body: None,
				stream,
			},
		),
	}
}

fn response_chunk_message_mk1(
	gateway_id: protocol::mk2::GatewayId,
	request_id: protocol::mk2::RequestId,
	finish: bool,
) -> protocol::ToServerTunnelMessage {
	protocol::ToServerTunnelMessage {
		message_id: protocol::MessageId {
			gateway_id,
			request_id,
			message_index: 0,
		},
		message_kind: protocol::ToServerTunnelMessageKind::ToServerResponseChunk(
			protocol::ToServerResponseChunk {
				body: b"chunk".to_vec(),
				finish,
			},
		),
	}
}

#[tokio::test]
async fn rejects_unissued_mk2_tunnel_message_pairs() {
	let pubsub = memory_pubsub("pegboard-runner-ws-to-tunnel-test-reject-mk2");
	let gateway_id = [1, 2, 3, 4];
	let request_id = [5, 6, 7, 8];
	let mut sub = pubsub
		.subscribe(&GatewayReceiverSubject::new(gateway_id).to_string())
		.await
		.unwrap();
	let authorized_tunnel_routes = HashMap::new();
	let tunnel_v2_adapter = tunnel_v2_adapter();

	let err = handle_tunnel_message_mk2(
		&pubsub,
		1024,
		&tunnel_v2_adapter,
		&authorized_tunnel_routes,
		response_abort_message_mk2(gateway_id, request_id),
	)
	.await
	.unwrap_err();
	assert!(err.to_string().contains("unauthorized tunnel message"));

	let recv = tokio::time::timeout(Duration::from_millis(50), sub.next()).await;
	assert!(recv.is_err());
}

#[tokio::test]
async fn republishes_issued_mk2_tunnel_message_pairs() {
	let pubsub = memory_pubsub("pegboard-runner-ws-to-tunnel-test-allow-mk2");
	let gateway_id = [9, 10, 11, 12];
	let request_id = [13, 14, 15, 16];
	let mut sub = pubsub
		.subscribe(&GatewayReceiverSubject::new(gateway_id).to_string())
		.await
		.unwrap();
	let authorized_tunnel_routes = HashMap::new();
	let tunnel_v2_adapter = tunnel_v2_adapter();
	let _ = authorized_tunnel_routes
		.insert_async((gateway_id, request_id), ())
		.await;

	handle_tunnel_message_mk2(
		&pubsub,
		1024,
		&tunnel_v2_adapter,
		&authorized_tunnel_routes,
		websocket_message_mk2(gateway_id, request_id),
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
	let decoded = protocol::versioned::ToGateway::deserialize_with_embedded_version(&msg.payload)
		.expect("gateway payload should decode");
	let protocol::mk2::ToGateway::ToServerTickWave(tick_wave) = decoded else {
		panic!("expected Tunnel v2 TickWave");
	};
	assert_eq!(tick_wave.wave.gateway_id, gateway_id);
	assert_eq!(tick_wave.wave.frames.len(), 1);
	assert_eq!(tick_wave.wave.frames[0].request_id, request_id);
	assert!(
		authorized_tunnel_routes
			.contains_async(&(gateway_id, request_id))
			.await
	);
}

#[tokio::test]
async fn mk2_route_lifetime_follows_terminal_messages() {
	let pubsub = memory_pubsub("pegboard-runner-ws-to-tunnel-test-clear-mk2");
	let gateway_id = [33, 34, 35, 36];
	let terminal_request_id = [37, 38, 39, 40];
	let stream_request_id = [41, 42, 43, 44];
	let chunk_request_id = [45, 46, 47, 48];
	let authorized_tunnel_routes = HashMap::new();
	let tunnel_v2_adapter = tunnel_v2_adapter();

	for request_id in [terminal_request_id, stream_request_id, chunk_request_id] {
		let _ = authorized_tunnel_routes
			.insert_async((gateway_id, request_id), ())
			.await;
	}

	handle_tunnel_message_mk2(
		&pubsub,
		1024,
		&tunnel_v2_adapter,
		&authorized_tunnel_routes,
		response_start_message_mk2(gateway_id, terminal_request_id),
	)
	.await
	.unwrap();
	assert!(
		!authorized_tunnel_routes
			.contains_async(&(gateway_id, terminal_request_id))
			.await
	);

	handle_tunnel_message_mk2(
		&pubsub,
		1024,
		&tunnel_v2_adapter,
		&authorized_tunnel_routes,
		response_start_message_mk2_with_stream(gateway_id, stream_request_id, true),
	)
	.await
	.unwrap();
	assert!(
		authorized_tunnel_routes
			.contains_async(&(gateway_id, stream_request_id))
			.await
	);

	handle_tunnel_message_mk2(
		&pubsub,
		1024,
		&tunnel_v2_adapter,
		&authorized_tunnel_routes,
		response_chunk_message_mk2(gateway_id, chunk_request_id, false),
	)
	.await
	.unwrap();
	assert!(
		authorized_tunnel_routes
			.contains_async(&(gateway_id, chunk_request_id))
			.await
	);

	handle_tunnel_message_mk2(
		&pubsub,
		1024,
		&tunnel_v2_adapter,
		&authorized_tunnel_routes,
		response_chunk_message_mk2(gateway_id, chunk_request_id, true),
	)
	.await
	.unwrap();
	assert!(
		!authorized_tunnel_routes
			.contains_async(&(gateway_id, chunk_request_id))
			.await
	);
}

#[tokio::test]
async fn rejects_unissued_mk2_tunnel_control_pairs() {
	let pubsub = memory_pubsub("pegboard-runner-ws-to-tunnel-test-reject-control-mk2");
	let gateway_id = [65, 66, 67, 68];
	let request_id = [69, 70, 71, 72];
	let mut sub = pubsub
		.subscribe(&GatewayReceiverSubject::new(gateway_id).to_string())
		.await
		.unwrap();
	let authorized_tunnel_routes = HashMap::new();

	let err = handle_tunnel_control_mk2(
		&pubsub,
		&authorized_tunnel_routes,
		protocol::mk2::ToServerTunnelControl {
			control: protocol::mk2::TunnelControl::TunnelAck(protocol::mk2::TunnelAck {
				gateway_id,
				request_id,
				last_acked_seq: 7,
			}),
		},
	)
	.await
	.unwrap_err();
	assert!(err.to_string().contains("unauthorized tunnel control"));

	let recv = tokio::time::timeout(Duration::from_millis(50), sub.next()).await;
	assert!(recv.is_err());
}

#[tokio::test]
async fn republishes_issued_mk2_tunnel_control_pairs() {
	let pubsub = memory_pubsub("pegboard-runner-ws-to-tunnel-test-allow-control-mk2");
	let gateway_id = [73, 74, 75, 76];
	let request_id = [77, 78, 79, 80];
	let mut sub = pubsub
		.subscribe(&GatewayReceiverSubject::new(gateway_id).to_string())
		.await
		.unwrap();
	let authorized_tunnel_routes = HashMap::new();
	let _ = authorized_tunnel_routes
		.insert_async((gateway_id, request_id), ())
		.await;

	handle_tunnel_control_mk2(
		&pubsub,
		&authorized_tunnel_routes,
		protocol::mk2::ToServerTunnelControl {
			control: protocol::mk2::TunnelControl::TunnelPressure(protocol::mk2::TunnelPressure {
				gateway_id,
				request_id: Some(request_id),
				pressure: protocol::mk2::Pressure {
					credit: 0,
					queue_depth: 8,
					oldest_age_ms: Some(25),
				},
			}),
		},
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
	let decoded = protocol::versioned::ToGateway::deserialize_with_embedded_version(&msg.payload)
		.expect("gateway payload should decode");
	let protocol::mk2::ToGateway::ToServerTunnelControl(control) = decoded else {
		panic!("expected Tunnel v2 control");
	};
	assert_eq!(
		control.control,
		protocol::mk2::TunnelControl::TunnelPressure(protocol::mk2::TunnelPressure {
			gateway_id,
			request_id: Some(request_id),
			pressure: protocol::mk2::Pressure {
				credit: 0,
				queue_depth: 8,
				oldest_age_ms: Some(25),
			},
		})
	);
	assert!(
		authorized_tunnel_routes
			.contains_async(&(gateway_id, request_id))
			.await
	);
}

#[tokio::test]
async fn republishes_issued_mk2_tunnel_resume_control_pairs() {
	let pubsub = memory_pubsub("pegboard-runner-ws-to-tunnel-test-allow-resume-mk2");
	let gateway_id = [85, 86, 87, 88];
	let request_id = [89, 90, 91, 92];
	let mut sub = pubsub
		.subscribe(&GatewayReceiverSubject::new(gateway_id).to_string())
		.await
		.unwrap();
	let authorized_tunnel_routes = HashMap::new();
	let _ = authorized_tunnel_routes
		.insert_async((gateway_id, request_id), ())
		.await;

	handle_tunnel_control_mk2(
		&pubsub,
		&authorized_tunnel_routes,
		protocol::mk2::ToServerTunnelControl {
			control: protocol::mk2::TunnelControl::TunnelResume(protocol::mk2::TunnelResume {
				gateway_id,
				request_id,
				last_acked_seq: 7,
			}),
		},
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
	let decoded = protocol::versioned::ToGateway::deserialize_with_embedded_version(&msg.payload)
		.expect("gateway payload should decode");
	let protocol::mk2::ToGateway::ToServerTunnelControl(control) = decoded else {
		panic!("expected Tunnel v2 control");
	};
	assert_eq!(
		control.control,
		protocol::mk2::TunnelControl::TunnelResume(protocol::mk2::TunnelResume {
			gateway_id,
			request_id,
			last_acked_seq: 7,
		})
	);
	assert!(
		authorized_tunnel_routes
			.contains_async(&(gateway_id, request_id))
			.await
	);
}

#[tokio::test]
async fn rejects_runner_pressure_control_without_request_id() {
	let pubsub = memory_pubsub("pegboard-runner-ws-to-tunnel-test-reject-global-pressure-mk2");
	let gateway_id = [81, 82, 83, 84];
	let mut sub = pubsub
		.subscribe(&GatewayReceiverSubject::new(gateway_id).to_string())
		.await
		.unwrap();
	let authorized_tunnel_routes = HashMap::new();

	let err = handle_tunnel_control_mk2(
		&pubsub,
		&authorized_tunnel_routes,
		protocol::mk2::ToServerTunnelControl {
			control: protocol::mk2::TunnelControl::TunnelPressure(protocol::mk2::TunnelPressure {
				gateway_id,
				request_id: None,
				pressure: protocol::mk2::Pressure {
					credit: 1,
					queue_depth: 0,
					oldest_age_ms: None,
				},
			}),
		},
	)
	.await
	.unwrap_err();
	assert!(
		err.to_string()
			.contains("runner pressure control must include request_id")
	);

	let recv = tokio::time::timeout(Duration::from_millis(50), sub.next()).await;
	assert!(recv.is_err());
}

#[tokio::test]
async fn rejects_unissued_mk1_tunnel_message_pairs() {
	let pubsub = memory_pubsub("pegboard-runner-ws-to-tunnel-test-reject-mk1");
	let gateway_id = [17, 18, 19, 20];
	let request_id = [21, 22, 23, 24];
	let mut sub = pubsub
		.subscribe(&GatewayReceiverSubject::new(gateway_id).to_string())
		.await
		.unwrap();
	let authorized_tunnel_routes = HashMap::new();

	let err = handle_tunnel_message_mk1(
		&pubsub,
		1024,
		&authorized_tunnel_routes,
		response_abort_message_mk1(gateway_id, request_id),
	)
	.await
	.unwrap_err();
	assert!(err.to_string().contains("unauthorized tunnel message"));

	let recv = tokio::time::timeout(Duration::from_millis(50), sub.next()).await;
	assert!(recv.is_err());
}

#[tokio::test]
async fn republishes_issued_mk1_tunnel_message_pairs() {
	let pubsub = memory_pubsub("pegboard-runner-ws-to-tunnel-test-allow-mk1");
	let gateway_id = [25, 26, 27, 28];
	let request_id = [29, 30, 31, 32];
	let mut sub = pubsub
		.subscribe(&GatewayReceiverSubject::new(gateway_id).to_string())
		.await
		.unwrap();
	let authorized_tunnel_routes = HashMap::new();
	let _ = authorized_tunnel_routes
		.insert_async((gateway_id, request_id), ())
		.await;

	handle_tunnel_message_mk1(
		&pubsub,
		1024,
		&authorized_tunnel_routes,
		websocket_message_mk1(gateway_id, request_id),
	)
	.await
	.unwrap();

	let msg = tokio::time::timeout(Duration::from_secs(1), sub.next())
		.await
		.unwrap()
		.unwrap();
	assert!(matches!(msg, NextOutput::Message(_)));
	assert!(
		authorized_tunnel_routes
			.contains_async(&(gateway_id, request_id))
			.await
	);
}

#[tokio::test]
async fn mk1_route_lifetime_follows_terminal_messages() {
	let pubsub = memory_pubsub("pegboard-runner-ws-to-tunnel-test-clear-mk1");
	let gateway_id = [49, 50, 51, 52];
	let terminal_request_id = [53, 54, 55, 56];
	let stream_request_id = [57, 58, 59, 60];
	let chunk_request_id = [61, 62, 63, 64];
	let authorized_tunnel_routes = HashMap::new();

	for request_id in [terminal_request_id, stream_request_id, chunk_request_id] {
		let _ = authorized_tunnel_routes
			.insert_async((gateway_id, request_id), ())
			.await;
	}

	handle_tunnel_message_mk1(
		&pubsub,
		1024,
		&authorized_tunnel_routes,
		response_start_message_mk1(gateway_id, terminal_request_id),
	)
	.await
	.unwrap();
	assert!(
		!authorized_tunnel_routes
			.contains_async(&(gateway_id, terminal_request_id))
			.await
	);

	handle_tunnel_message_mk1(
		&pubsub,
		1024,
		&authorized_tunnel_routes,
		response_start_message_mk1_with_stream(gateway_id, stream_request_id, true),
	)
	.await
	.unwrap();
	assert!(
		authorized_tunnel_routes
			.contains_async(&(gateway_id, stream_request_id))
			.await
	);

	handle_tunnel_message_mk1(
		&pubsub,
		1024,
		&authorized_tunnel_routes,
		response_chunk_message_mk1(gateway_id, chunk_request_id, false),
	)
	.await
	.unwrap();
	assert!(
		authorized_tunnel_routes
			.contains_async(&(gateway_id, chunk_request_id))
			.await
	);

	handle_tunnel_message_mk1(
		&pubsub,
		1024,
		&authorized_tunnel_routes,
		response_chunk_message_mk1(gateway_id, chunk_request_id, true),
	)
	.await
	.unwrap();
	assert!(
		!authorized_tunnel_routes
			.contains_async(&(gateway_id, chunk_request_id))
			.await
	);
}
