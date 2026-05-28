use tunnel_fabric::{
	FabricConfig, OutboundFrame, ReplayBuffer, ReplayGap, ReplayOutcome, ShardedReceiver,
	WaveSequencer, gateway_partition_key, lane_publish_opts, protocol, ups_lane_spec,
};
use universalpubsub::{LaneOrdering, LanePriority, OnFull};

const GATEWAY: [u8; 4] = [0xab, 0xcd, 0xef, 0x01];
const REQ_A: [u8; 4] = [1, 0, 0, 0];
const REQ_B: [u8; 4] = [2, 0, 0, 0];

fn request_id(index: u32) -> [u8; 4] {
	index.to_le_bytes()
}

fn frame(request_id: [u8; 4], bytes: &'static [u8]) -> OutboundFrame {
	OutboundFrame::single(request_id, protocol::TunnelFrameKind::WebSocket, bytes)
}

fn replay_frames(outcome: ReplayOutcome) -> Vec<protocol::TunnelFrame> {
	match outcome {
		ReplayOutcome::Frames(frames) => frames,
		ReplayOutcome::FullResyncRequired(gap) => {
			panic!("expected replay frames, got full resync gap: {gap:?}")
		}
	}
}

#[test]
fn tunnel_lane_uses_gateway_partition_policy() {
	let spec = ups_lane_spec(128);

	assert_eq!(spec.capacity, 128);
	assert_eq!(spec.on_full, OnFull::DropOldest);
	assert_eq!(spec.ordering, LaneOrdering::PerPartitionKey);
	assert!(spec.local_fast_path);
	assert_eq!(spec.priority, LanePriority::High);
	assert_eq!(gateway_partition_key(GATEWAY), "abcdef01");
	assert_eq!(
		lane_publish_opts(GATEWAY).partition_key.as_deref(),
		Some("abcdef01")
	);
}

#[test]
fn sequencer_preserves_per_request_ordering_inside_waves() {
	let mut sequencer = WaveSequencer::new(GATEWAY);
	let mut batched = frame(REQ_A, b"a2-a3");
	batched.sequence_count = 2;

	let wave = sequencer.build_wave([frame(REQ_A, b"a1"), frame(REQ_B, b"b1"), batched], None);

	assert_eq!(wave.epoch, 1);
	assert_eq!(
		wave.frames[0].sequence_range,
		protocol::SequenceRange { first: 1, last: 1 }
	);
	assert_eq!(
		wave.frames[1].sequence_range,
		protocol::SequenceRange { first: 1, last: 1 }
	);
	assert_eq!(
		wave.frames[2].sequence_range,
		protocol::SequenceRange { first: 2, last: 3 }
	);

	let next = sequencer.build_wave([frame(REQ_A, b"a4")], None);
	assert_eq!(next.epoch, 2);
	assert_eq!(
		next.frames[0].sequence_range,
		protocol::SequenceRange { first: 4, last: 4 }
	);
}

#[test]
fn sequencer_preserves_100k_mixed_ordering_across_random_batch_boundaries() {
	const FRAME_COUNT: u64 = 100_000;

	let mut sequencer = WaveSequencer::new(GATEWAY);
	let mut seed = 0x1234_5678_90ab_cdef_u64;
	let mut produced = 0;
	let mut expected_epoch = 1;
	let mut expected_sequence = 1;

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
			batch.push(OutboundFrame::single(REQ_A, message_kind, bytes));
			produced += 1;
		}

		let wave = sequencer.build_wave(batch, None);
		assert_eq!(wave.epoch, expected_epoch);
		expected_epoch += 1;

		for frame in wave.frames {
			assert_eq!(frame.request_id, REQ_A);
			assert_eq!(
				frame.sequence_range,
				protocol::SequenceRange {
					first: expected_sequence,
					last: expected_sequence,
				}
			);
			expected_sequence += 1;
		}
	}

	assert_eq!(expected_sequence - 1, FRAME_COUNT);
}

#[test]
fn replay_buffer_returns_only_unacked_frames() {
	let mut sequencer = WaveSequencer::new(GATEWAY);
	let wave = sequencer.build_wave(
		[
			frame(REQ_A, b"a1"),
			frame(REQ_A, b"a2"),
			frame(REQ_B, b"b1"),
		],
		None,
	);
	let mut replay = ReplayBuffer::new(4);
	replay.push_wave(&wave);

	let pending = replay_frames(replay.replay_after(REQ_A, 1));

	assert_eq!(pending.len(), 1);
	assert_eq!(pending[0].bytes, b"a2");
	assert_eq!(replay_frames(replay.replay_after(REQ_B, 0))[0].bytes, b"b1");
}

#[test]
fn replay_buffer_at_capacity_requires_full_resync_on_stale_ack() {
	let mut sequencer = WaveSequencer::new(GATEWAY);
	let wave = sequencer.build_wave(
		[
			frame(REQ_A, b"a1"),
			frame(REQ_A, b"a2"),
			frame(REQ_A, b"a3"),
		],
		None,
	);
	let mut replay = ReplayBuffer::new(2);
	replay.push_wave(&wave);

	assert_eq!(
		replay.replay_after(REQ_A, 0),
		ReplayOutcome::FullResyncRequired(ReplayGap {
			request_id: REQ_A,
			last_acked_seq: 0,
			first_available_seq: Some(2),
			last_available_seq: Some(3),
		})
	);

	let pending = replay_frames(replay.replay_after(REQ_A, 1));

	assert_eq!(
		pending.iter().map(|frame| &frame.bytes).collect::<Vec<_>>(),
		vec![b"a2", b"a3"]
	);
}

#[test]
fn replay_buffer_rejects_resume_newer_than_retained_tail() {
	let mut sequencer = WaveSequencer::new(GATEWAY);
	let wave = sequencer.build_wave([frame(REQ_A, b"a1"), frame(REQ_A, b"a2")], None);
	let mut replay = ReplayBuffer::new(4);
	replay.push_wave(&wave);

	assert_eq!(
		replay.replay_after(REQ_A, 99),
		ReplayOutcome::FullResyncRequired(ReplayGap {
			request_id: REQ_A,
			last_acked_seq: 99,
			first_available_seq: Some(1),
			last_available_seq: Some(2),
		})
	);
}

#[test]
fn replay_buffer_rejects_partial_multi_sequence_resume() {
	let mut sequencer = WaveSequencer::new(GATEWAY);
	let mut batched = frame(REQ_A, b"a2-a3");
	batched.sequence_count = 2;
	let wave = sequencer.build_wave([frame(REQ_A, b"a1"), batched, frame(REQ_A, b"a4")], None);
	let mut replay = ReplayBuffer::new(4);
	replay.push_wave(&wave);

	assert_eq!(
		replay.replay_after(REQ_A, 2),
		ReplayOutcome::FullResyncRequired(ReplayGap {
			request_id: REQ_A,
			last_acked_seq: 2,
			first_available_seq: Some(1),
			last_available_seq: Some(4),
		})
	);
	assert_eq!(
		replay_frames(replay.replay_after(REQ_A, 1))
			.iter()
			.map(|frame| frame.bytes.as_slice())
			.collect::<Vec<_>>(),
		vec![b"a2-a3".as_slice(), b"a4".as_slice()]
	);
	assert_eq!(replay_frames(replay.replay_after(REQ_A, 3))[0].bytes, b"a4");
}

#[test]
fn sharded_receiver_isolates_slow_clients_with_per_request_bounds() {
	let mut sequencer = WaveSequencer::new(GATEWAY);
	let wave = sequencer.build_wave(
		[
			frame(REQ_A, b"a1"),
			frame(REQ_A, b"a2"),
			frame(REQ_A, b"a3"),
			frame(REQ_B, b"b1"),
		],
		None,
	);
	let mut receiver = ShardedReceiver::new(FabricConfig::new(2, 2));

	receiver.enqueue_wave(&wave);

	assert_eq!(receiver.pressure(REQ_A).queue_depth, 2);
	assert_eq!(receiver.pressure(REQ_A).dropped_frames, 1);
	assert_eq!(receiver.pressure(REQ_B).queue_depth, 1);
	assert_eq!(receiver.pressure(REQ_B).dropped_frames, 0);
	assert_eq!(receiver.pop_for_request(REQ_B).unwrap().frame.bytes, b"b1");
}

#[test]
fn slow_consumer_isolation_keeps_99_fast_requests_ready() {
	const FAST_REQUESTS: u32 = 99;
	const SLOW_FRAMES: usize = 8;
	const SLOW_CAPACITY: usize = 3;

	let slow_request = request_id(10_000);
	let mut sequencer = WaveSequencer::new(GATEWAY);
	let mut frames = Vec::new();
	frames.extend((0..SLOW_FRAMES).map(|_| frame(slow_request, b"slow")));
	frames.extend((0..FAST_REQUESTS).map(|idx| frame(request_id(idx), b"fast")));
	let wave = sequencer.build_wave(frames, None);
	let mut receiver = ShardedReceiver::new(FabricConfig::new(8, SLOW_CAPACITY));

	receiver.enqueue_wave(&wave);

	let slow_pressure = receiver.pressure(slow_request);
	assert_eq!(slow_pressure.queue_depth, SLOW_CAPACITY);
	assert_eq!(slow_pressure.credit, 0);
	assert_eq!(
		slow_pressure.dropped_frames,
		(SLOW_FRAMES - SLOW_CAPACITY) as u64
	);

	for idx in 0..FAST_REQUESTS {
		let request_id = request_id(idx);
		let pressure = receiver.pressure(request_id);
		assert_eq!(pressure.queue_depth, 1);
		assert_eq!(pressure.dropped_frames, 0);
		assert_eq!(
			receiver
				.pop_for_request(request_id)
				.expect("fast request should not be blocked by slow request")
				.frame
				.bytes,
			b"fast"
		);
	}
}

#[test]
fn drain_ready_round_robins_requests_in_a_shard() {
	let mut sequencer = WaveSequencer::new(GATEWAY);
	let wave = sequencer.build_wave(
		[
			frame(REQ_A, b"a1"),
			frame(REQ_A, b"a2"),
			frame(REQ_A, b"a3"),
			frame(REQ_B, b"b1"),
			frame(REQ_B, b"b2"),
			frame(REQ_B, b"b3"),
		],
		None,
	);
	let mut receiver = ShardedReceiver::new(FabricConfig::new(1, 8));
	receiver.enqueue_wave(&wave);

	let delivered = receiver.drain_ready(4);

	assert_eq!(
		delivered
			.iter()
			.map(|frame| frame.frame.bytes.as_slice())
			.collect::<Vec<_>>(),
		vec![b"a1", b"b1", b"a2", b"b2"]
	);
}

#[test]
fn mixed_traffic_fairness_delivers_idle_requests_before_hot_tail() {
	const IDLE_REQUESTS: u32 = 99;
	const HOT_FRAMES: usize = 30;

	let hot_request = request_id(50_000);
	let mut sequencer = WaveSequencer::new(GATEWAY);
	let mut frames = Vec::new();
	frames.extend((0..HOT_FRAMES).map(|_| frame(hot_request, b"hot")));
	frames.extend((0..IDLE_REQUESTS).map(|idx| frame(request_id(idx), b"idle")));
	let wave = sequencer.build_wave(frames, None);
	let mut receiver = ShardedReceiver::new(FabricConfig::new(1, HOT_FRAMES + 1));

	receiver.enqueue_wave(&wave);

	let first_round = receiver.drain_ready(1 + IDLE_REQUESTS as usize);
	assert_eq!(first_round.len(), 1 + IDLE_REQUESTS as usize);
	assert_eq!(first_round[0].request_id, hot_request);
	assert_eq!(first_round[0].frame.bytes, b"hot");

	let idle_delivered = first_round
		.iter()
		.skip(1)
		.map(|delivered| delivered.request_id)
		.collect::<Vec<_>>();
	assert_eq!(
		idle_delivered,
		(0..IDLE_REQUESTS).map(request_id).collect::<Vec<_>>()
	);

	let hot_tail = receiver.drain_ready(HOT_FRAMES);
	assert_eq!(hot_tail.len(), HOT_FRAMES - 1);
	assert!(
		hot_tail
			.iter()
			.all(|delivered| delivered.request_id == hot_request)
	);
}

#[test]
fn pressure_reports_credit_and_depth() {
	let mut sequencer = WaveSequencer::new(GATEWAY);
	let wave = sequencer.build_wave([frame(REQ_A, b"a1"), frame(REQ_A, b"a2")], None);
	let mut receiver = ShardedReceiver::new(FabricConfig::new(1, 4));

	receiver.enqueue_wave(&wave);
	let pressure = receiver.pressure(REQ_A);

	assert_eq!(pressure.capacity, 4);
	assert_eq!(pressure.queue_depth, 2);
	assert_eq!(pressure.credit, 2);
	assert!(pressure.oldest_age.is_some());
}
