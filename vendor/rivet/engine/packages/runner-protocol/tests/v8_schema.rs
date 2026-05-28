use rivet_runner_protocol::{
	PROTOCOL_MK2_VERSION,
	generated::v8,
	versioned::{ToGateway, ToServerMk2},
};
use vbare::OwnedVersionedData;

fn round_trip<T>(value: T) -> T
where
	T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
	let encoded = serde_bare::to_vec(&value).expect("v8 payload should encode");
	let decoded = serde_bare::from_slice(&encoded).expect("v8 payload should decode");
	assert_eq!(decoded, value);
	decoded
}

fn sample_wave() -> v8::TickWave {
	v8::TickWave {
		epoch: 42,
		gateway_id: [1, 2, 3, 4],
		frames: vec![
			v8::TunnelFrame {
				request_id: [5, 6, 7, 8],
				sequence_range: v8::SequenceRange {
					first: 10,
					last: 12,
				},
				message_kind: v8::TunnelFrameKind::WebSocket,
				bytes: b"first frame".to_vec(),
			},
			v8::TunnelFrame {
				request_id: [9, 10, 11, 12],
				sequence_range: v8::SequenceRange { first: 1, last: 1 },
				message_kind: v8::TunnelFrameKind::Lifecycle,
				bytes: b"second frame".to_vec(),
			},
		],
		backpressure: Some(v8::Pressure {
			credit: 7,
			queue_depth: 3,
			oldest_age_ms: Some(250),
		}),
	}
}

#[test]
fn tick_wave_round_trips_on_runner_unions() {
	let wave = sample_wave();

	round_trip(v8::ToServer::ToServerTickWave(v8::ToServerTickWave {
		wave: wave.clone(),
	}));
	round_trip(v8::ToClient::ToClientTickWave(v8::ToClientTickWave {
		wave: wave.clone(),
	}));
	round_trip(v8::ToRunner::ToClientTickWave(v8::ToClientTickWave {
		wave: wave.clone(),
	}));
	round_trip(v8::ToGateway::ToServerTickWave(v8::ToServerTickWave {
		wave,
	}));
}

#[test]
fn tunnel_control_round_trips_resume_ack_and_pressure() {
	round_trip(v8::ToServer::ToServerTunnelControl(
		v8::ToServerTunnelControl {
			control: v8::TunnelControl::TunnelResume(v8::TunnelResume {
				gateway_id: [1, 1, 1, 1],
				request_id: [2, 2, 2, 2],
				last_acked_seq: 99,
			}),
		},
	));

	round_trip(v8::ToClient::ToClientTunnelControl(
		v8::ToClientTunnelControl {
			control: v8::TunnelControl::TunnelAck(v8::TunnelAck {
				gateway_id: [3, 3, 3, 3],
				request_id: [4, 4, 4, 4],
				last_acked_seq: 100,
			}),
		},
	));

	round_trip(v8::ToGateway::ToServerTunnelControl(
		v8::ToServerTunnelControl {
			control: v8::TunnelControl::TunnelPressure(v8::TunnelPressure {
				gateway_id: [5, 5, 5, 5],
				request_id: Some([6, 6, 6, 6]),
				pressure: v8::Pressure {
					credit: 0,
					queue_depth: 128,
					oldest_age_ms: None,
				},
			}),
		},
	));
}

#[test]
fn mk2_latest_version_is_v8_and_round_trips_tick_wave() {
	assert_eq!(PROTOCOL_MK2_VERSION, 8);

	let message = v8::ToServer::ToServerTickWave(v8::ToServerTickWave {
		wave: sample_wave(),
	});
	let encoded = <ToServerMk2 as OwnedVersionedData>::wrap_latest(message.clone())
		.serialize(PROTOCOL_MK2_VERSION)
		.expect("v8 TickWave should serialize at the latest mk2 version");
	let decoded = <ToServerMk2 as OwnedVersionedData>::deserialize(&encoded, PROTOCOL_MK2_VERSION)
		.expect("v8 TickWave should deserialize at the latest mk2 version");

	assert_eq!(decoded, message);
}

#[test]
fn legacy_mk2_payloads_still_downgrade_to_v7() {
	let message = v8::ToServer::ToServerPong(v8::ToServerPong { ts: 1234 });
	let encoded_v7 = <ToServerMk2 as OwnedVersionedData>::wrap_latest(message.clone())
		.serialize(7)
		.expect("legacy v8 mk2 payload should downgrade to v7");
	let decoded = <ToServerMk2 as OwnedVersionedData>::deserialize(&encoded_v7, 7)
		.expect("v7 payload should upgrade back to v8 latest");

	assert_eq!(decoded, message);
}

#[test]
fn v8_only_payloads_do_not_silently_downgrade_to_v7() {
	let message = v8::ToServer::ToServerTickWave(v8::ToServerTickWave {
		wave: sample_wave(),
	});

	assert!(
		<ToServerMk2 as OwnedVersionedData>::wrap_latest(message)
			.serialize(7)
			.is_err(),
		"TickWave must not be serialized to a v7 peer"
	);
}

#[test]
fn gateway_versioned_wrapper_accepts_v8_tunnel_control() {
	let message = v8::ToGateway::ToServerTunnelControl(v8::ToServerTunnelControl {
		control: v8::TunnelControl::TunnelAck(v8::TunnelAck {
			gateway_id: [7, 7, 7, 7],
			request_id: [8, 8, 8, 8],
			last_acked_seq: 44,
		}),
	});
	let encoded = <ToGateway as OwnedVersionedData>::wrap_latest(message.clone())
		.serialize(PROTOCOL_MK2_VERSION)
		.expect("v8 gateway tunnel control should serialize");
	let decoded = <ToGateway as OwnedVersionedData>::deserialize(&encoded, PROTOCOL_MK2_VERSION)
		.expect("v8 gateway tunnel control should deserialize");

	assert_eq!(decoded, message);
}
