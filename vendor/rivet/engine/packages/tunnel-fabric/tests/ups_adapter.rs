use std::sync::Arc;
use std::time::Duration;

use tunnel_fabric::{
	FabricConfig, OutboundFrame, ReplayBuffer, ReplayOutcome, ShardedReceiver, WaveSequencer,
	protocol,
	ups::{self, UpsWaveLane},
	ups_lane_spec,
};
use universalpubsub::{PubSub, driver::memory::MemoryDriver};

const GATEWAY: [u8; 4] = [0xaa, 0xbb, 0xcc, 0xdd];
const REQUEST: [u8; 4] = [1, 2, 3, 4];
const OTHER_REQUEST: [u8; 4] = [5, 6, 7, 8];

fn frame(request_id: [u8; 4], bytes: &'static [u8]) -> OutboundFrame {
	OutboundFrame::single(request_id, protocol::TunnelFrameKind::WebSocket, bytes)
}

fn typed_frame(
	request_id: [u8; 4],
	message_kind: protocol::TunnelFrameKind,
	bytes: &'static [u8],
) -> OutboundFrame {
	OutboundFrame::single(request_id, message_kind, bytes)
}

fn replay_frames(outcome: ReplayOutcome) -> Vec<protocol::TunnelFrame> {
	match outcome {
		ReplayOutcome::Frames(frames) => frames,
		ReplayOutcome::FullResyncRequired(gap) => {
			panic!("expected replay frames, got full resync gap: {gap:?}")
		}
	}
}

fn wave() -> protocol::TickWave {
	let mut sequencer = WaveSequencer::new(GATEWAY);
	sequencer.build_wave(
		[frame(REQUEST, b"tick")],
		Some(protocol::Pressure {
			credit: 8,
			queue_depth: 2,
			oldest_age_ms: Some(40),
		}),
	)
}

#[tokio::test]
async fn publishes_tickwaves_over_a_ups_lane() {
	let pubsub = PubSub::new(Arc::new(MemoryDriver::new(
		"tunnel-fabric-ups-adapter".to_string(),
	)));
	let lane = pubsub
		.named_lane("tunnel-v2", ups_lane_spec(16))
		.expect("lane should build");
	let adapter = UpsWaveLane::new(lane);
	let mut subscriber = adapter
		.subscribe_gateway(GATEWAY)
		.await
		.expect("gateway subscriber should build");
	let wave = wave();

	let outcome = adapter
		.publish_wave(&wave)
		.await
		.expect("wave should publish");
	let received = tokio::time::timeout(Duration::from_secs(1), subscriber.next_wave())
		.await
		.expect("subscriber should receive wave")
		.expect("subscriber should decode wave")
		.expect("subscriber should not close");

	assert!(outcome.accepted);
	assert_eq!(received, wave);
}

#[tokio::test]
async fn subscriber_feeds_sharded_receiver() {
	let pubsub = PubSub::new(Arc::new(MemoryDriver::new(
		"tunnel-fabric-ups-receiver".to_string(),
	)));
	let lane = pubsub
		.named_lane("tunnel-v2", ups_lane_spec(16))
		.expect("lane should build");
	let adapter = UpsWaveLane::new(lane);
	let mut subscriber = adapter
		.subscribe_gateway(GATEWAY)
		.await
		.expect("gateway subscriber should build");
	let mut receiver = ShardedReceiver::new(FabricConfig::new(2, 8));
	let wave = wave();

	adapter
		.publish_wave(&wave)
		.await
		.expect("wave should publish");
	let pressure = tokio::time::timeout(
		Duration::from_secs(1),
		subscriber.next_into_receiver(&mut receiver),
	)
	.await
	.expect("subscriber should receive wave")
	.expect("subscriber should enqueue wave")
	.expect("subscriber should not close");

	assert_eq!(pressure[0].request_id, REQUEST);
	assert_eq!(receiver.drain_ready(1)[0].frame, wave.frames[0]);
}

#[tokio::test]
async fn cross_host_ups_delivery_preserves_ordering_and_replay_without_local_fast_path() {
	let driver = MemoryDriver::new("tunnel-fabric-cross-host-ups".to_string());
	let runner_pubsub = PubSub::new_with_memory_optimization(Arc::new(driver.clone()), false);
	let gateway_pubsub = PubSub::new_with_memory_optimization(Arc::new(driver), false);
	let runner_lane = runner_pubsub
		.named_lane("tunnel-v2", ups_lane_spec(16))
		.expect("runner lane should build");
	let gateway_lane = gateway_pubsub
		.named_lane("tunnel-v2", ups_lane_spec(16))
		.expect("gateway lane should build");
	let publisher = UpsWaveLane::new(runner_lane);
	let mut subscriber = UpsWaveLane::new(gateway_lane)
		.subscribe_gateway(GATEWAY)
		.await
		.expect("gateway subscriber should build");
	let pressure = protocol::Pressure {
		credit: 4,
		queue_depth: 1,
		oldest_age_ms: Some(7),
	};

	let mut sequencer = WaveSequencer::new(GATEWAY);
	let wave_one = sequencer.build_wave([frame(REQUEST, b"a1"), frame(OTHER_REQUEST, b"b1")], None);
	let wave_two = sequencer.build_wave([frame(REQUEST, b"a2")], Some(pressure.clone()));
	let wave_three =
		sequencer.build_wave([frame(REQUEST, b"a3"), frame(OTHER_REQUEST, b"b2")], None);

	for wave in [&wave_one, &wave_two, &wave_three] {
		let outcome = publisher
			.publish_wave(wave)
			.await
			.expect("wave should publish through UPS");
		assert!(outcome.accepted);
	}

	let mut received = Vec::new();
	for _ in 0..3 {
		received.push(
			tokio::time::timeout(Duration::from_secs(1), subscriber.next_wave())
				.await
				.expect("subscriber should receive wave")
				.expect("subscriber should decode wave")
				.expect("subscriber should not close"),
		);
	}

	assert_eq!(
		received,
		vec![wave_one.clone(), wave_two.clone(), wave_three.clone()]
	);
	assert_eq!(received[1].backpressure, Some(pressure));

	let mut receiver = ShardedReceiver::new(FabricConfig::new(2, 8));
	let mut replay = ReplayBuffer::new(4);
	for wave in &received {
		replay.push_wave(wave);
		receiver.enqueue_wave(wave);
	}

	let delivered = receiver.drain_ready(8);
	let request_frames = delivered
		.iter()
		.filter(|delivered| delivered.request_id == REQUEST)
		.map(|delivered| delivered.frame.clone())
		.collect::<Vec<_>>();
	assert_eq!(
		request_frames
			.iter()
			.map(|frame| frame.sequence_range.clone())
			.collect::<Vec<_>>(),
		vec![
			protocol::SequenceRange { first: 1, last: 1 },
			protocol::SequenceRange { first: 2, last: 2 },
			protocol::SequenceRange { first: 3, last: 3 },
		]
	);
	assert_eq!(
		request_frames
			.iter()
			.map(|frame| frame.bytes.as_slice())
			.collect::<Vec<_>>(),
		vec![b"a1", b"a2", b"a3"]
	);

	let replay_after_first = replay_frames(replay.replay_after(REQUEST, 1));
	assert_eq!(
		replay_after_first
			.iter()
			.map(|frame| frame.bytes.as_slice())
			.collect::<Vec<_>>(),
		vec![b"a2", b"a3"]
	);
	assert_eq!(
		replay_frames(replay.replay_after(OTHER_REQUEST, 0))
			.iter()
			.map(|frame| frame.bytes.as_slice())
			.collect::<Vec<_>>(),
		vec![b"b1", b"b2"]
	);
}

#[tokio::test]
async fn cross_host_ups_preserves_100k_ordering_and_replay_across_random_batch_boundaries() {
	const FRAME_COUNT: u64 = 100_000;

	let driver = MemoryDriver::new("tunnel-fabric-cross-host-ups-100k".to_string());
	let runner_pubsub = PubSub::new_with_memory_optimization(Arc::new(driver.clone()), false);
	let gateway_pubsub = PubSub::new_with_memory_optimization(Arc::new(driver), false);
	let runner_lane = runner_pubsub
		.named_lane("tunnel-v2", ups_lane_spec(4096))
		.expect("runner lane should build");
	let gateway_lane = gateway_pubsub
		.named_lane("tunnel-v2", ups_lane_spec(4096))
		.expect("gateway lane should build");
	let publisher = UpsWaveLane::new(runner_lane);
	let mut subscriber = UpsWaveLane::new(gateway_lane)
		.subscribe_gateway(GATEWAY)
		.await
		.expect("gateway subscriber should build");

	let mut sequencer = WaveSequencer::new(GATEWAY);
	let mut seed = 0xfeed_beef_cafe_babe_u64;
	let mut produced = 0;
	let mut wave_count = 0;
	while produced < FRAME_COUNT {
		seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
		let batch_len = (((seed >> 32) % 97) + 1).min(FRAME_COUNT - produced) as usize;
		let mut batch = Vec::with_capacity(batch_len);
		for _ in 0..batch_len {
			let (message_kind, bytes): (_, &'static [u8]) = if produced % 2 == 0 {
				(
					protocol::TunnelFrameKind::WebSocket,
					b"broadcast".as_slice(),
				)
			} else {
				(protocol::TunnelFrameKind::Action, b"action".as_slice())
			};
			batch.push(typed_frame(REQUEST, message_kind, bytes));
			produced += 1;
		}

		let wave = sequencer.build_wave(batch, None);
		let outcome = publisher
			.publish_wave(&wave)
			.await
			.expect("wave should publish through UPS");
		assert!(outcome.accepted);
		assert_eq!(outcome.dropped_messages, 0);
		wave_count += 1;
	}

	let mut replay = ReplayBuffer::new(FRAME_COUNT as usize);
	let mut expected_epoch = 1;
	let mut expected_sequence = 1;
	let mut received_frames = 0;
	tokio::time::timeout(Duration::from_secs(5), async {
		for _ in 0..wave_count {
			let wave = subscriber
				.next_wave()
				.await
				.expect("subscriber should receive wave")
				.expect("subscriber should not close");
			assert_eq!(wave.epoch, expected_epoch);
			expected_epoch += 1;
			replay.push_wave(&wave);

			for frame in &wave.frames {
				assert_eq!(frame.request_id, REQUEST);
				assert_eq!(
					frame.sequence_range,
					protocol::SequenceRange {
						first: expected_sequence,
						last: expected_sequence,
					}
				);
				expected_sequence += 1;
				received_frames += 1;
			}
		}
	})
	.await
	.expect("subscriber should receive all cross-host waves");

	assert_eq!(received_frames, FRAME_COUNT);
	let replayed = replay_frames(replay.replay_after(REQUEST, FRAME_COUNT / 2));
	assert_eq!(replayed.len() as u64, FRAME_COUNT / 2);
	assert_eq!(replayed[0].sequence_range.first, FRAME_COUNT / 2 + 1);
	assert_eq!(replayed.last().unwrap().sequence_range.last, FRAME_COUNT);
}

#[test]
fn subject_uses_gateway_partition_key() {
	assert_eq!(
		ups::subject_for_gateway(GATEWAY),
		"rivet.tunnel.v2.gateway.aabbccdd"
	);
}

#[test]
fn wave_codec_round_trips_and_rejects_invalid_payloads() {
	let wave = wave();
	let encoded = ups::encode_wave(&wave).expect("wave should encode");

	assert_eq!(ups::decode_wave(&encoded).unwrap(), wave);
	assert!(ups::decode_wave(b"not-a-wave").is_err());
}
