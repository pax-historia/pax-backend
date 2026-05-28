use std::{
	collections::{BTreeMap, VecDeque},
	fmt::Write,
	time::{Duration, Instant},
};

pub use rivet_runner_protocol::mk2 as protocol;
use universalpubsub::{LanePublishOpts, LaneSpec};

pub mod legacy;
pub mod runner_gateway;
pub mod ups;

pub type GatewayId = protocol::GatewayId;
pub type RequestId = protocol::RequestId;

/// UPS lane policy used by Tunnel v2 waves.
pub fn ups_lane_spec(capacity: usize) -> LaneSpec {
	LaneSpec::tunnel_v2(capacity)
}

/// Stable partition key for UPS lanes and future transport streams.
pub fn gateway_partition_key(gateway_id: GatewayId) -> String {
	let mut key = String::with_capacity(gateway_id.len() * 2);
	for byte in gateway_id {
		let _ = write!(&mut key, "{byte:02x}");
	}
	key
}

pub fn lane_publish_opts(gateway_id: GatewayId) -> LanePublishOpts {
	LanePublishOpts::partition_key(gateway_partition_key(gateway_id))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutboundFrame {
	pub request_id: RequestId,
	pub message_kind: protocol::TunnelFrameKind,
	pub bytes: Vec<u8>,
	pub sequence_count: u64,
}

impl OutboundFrame {
	pub fn single(
		request_id: RequestId,
		message_kind: protocol::TunnelFrameKind,
		bytes: impl Into<Vec<u8>>,
	) -> Self {
		Self {
			request_id,
			message_kind,
			bytes: bytes.into(),
			sequence_count: 1,
		}
	}
}

#[derive(Clone, Debug)]
pub struct WaveSequencer {
	gateway_id: GatewayId,
	next_epoch: u64,
	next_sequence: BTreeMap<RequestId, u64>,
}

impl WaveSequencer {
	pub fn new(gateway_id: GatewayId) -> Self {
		Self {
			gateway_id,
			next_epoch: 1,
			next_sequence: BTreeMap::new(),
		}
	}

	pub fn build_wave(
		&mut self,
		frames: impl IntoIterator<Item = OutboundFrame>,
		backpressure: Option<protocol::Pressure>,
	) -> protocol::TickWave {
		let epoch = self.next_epoch;
		self.next_epoch += 1;

		let frames = frames
			.into_iter()
			.map(|frame| {
				let sequence_count = frame.sequence_count.max(1);
				let next_sequence = self.next_sequence.entry(frame.request_id).or_insert(1);
				let first = *next_sequence;
				let last = first + sequence_count - 1;
				*next_sequence = last + 1;

				protocol::TunnelFrame {
					request_id: frame.request_id,
					sequence_range: protocol::SequenceRange { first, last },
					message_kind: frame.message_kind,
					bytes: frame.bytes,
				}
			})
			.collect();

		protocol::TickWave {
			epoch,
			gateway_id: self.gateway_id,
			frames,
			backpressure,
		}
	}
}

#[derive(Debug)]
pub struct ReplayBuffer {
	capacity_per_request: usize,
	frames: BTreeMap<RequestId, VecDeque<protocol::TunnelFrame>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReplayOutcome {
	Frames(Vec<protocol::TunnelFrame>),
	FullResyncRequired(ReplayGap),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplayGap {
	pub request_id: RequestId,
	pub last_acked_seq: u64,
	pub first_available_seq: Option<u64>,
	pub last_available_seq: Option<u64>,
}

impl ReplayBuffer {
	pub fn new(capacity_per_request: usize) -> Self {
		assert!(
			capacity_per_request > 0,
			"replay capacity must be greater than zero"
		);

		Self {
			capacity_per_request,
			frames: BTreeMap::new(),
		}
	}

	pub fn push_wave(&mut self, wave: &protocol::TickWave) {
		for frame in &wave.frames {
			let queue = self.frames.entry(frame.request_id).or_default();
			queue.push_back(frame.clone());
			while queue.len() > self.capacity_per_request {
				queue.pop_front();
			}
		}
	}

	pub fn replay_after(&self, request_id: RequestId, last_acked_seq: u64) -> ReplayOutcome {
		let Some(frames) = self.frames.get(&request_id) else {
			return if last_acked_seq == 0 {
				ReplayOutcome::Frames(Vec::new())
			} else {
				ReplayOutcome::FullResyncRequired(ReplayGap {
					request_id,
					last_acked_seq,
					first_available_seq: None,
					last_available_seq: None,
				})
			};
		};

		let first_available_seq = frames
			.front()
			.map(|frame| frame.sequence_range.first)
			.unwrap_or(1);
		let last_available_seq = frames
			.back()
			.map(|frame| frame.sequence_range.last)
			.unwrap_or(0);

		let gap = || ReplayGap {
			request_id,
			last_acked_seq,
			first_available_seq: frames.front().map(|frame| frame.sequence_range.first),
			last_available_seq: frames.back().map(|frame| frame.sequence_range.last),
		};

		if last_acked_seq < first_available_seq.saturating_sub(1)
			|| last_acked_seq > last_available_seq
		{
			return ReplayOutcome::FullResyncRequired(gap());
		}

		let mut pending = Vec::new();
		for frame in frames {
			if frame.sequence_range.last <= last_acked_seq {
				continue;
			}

			if frame.sequence_range.first <= last_acked_seq {
				return ReplayOutcome::FullResyncRequired(gap());
			}

			pending.push(frame.clone());
		}

		ReplayOutcome::Frames(pending)
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FabricConfig {
	pub shard_count: usize,
	pub per_request_capacity: usize,
}

impl FabricConfig {
	pub fn new(shard_count: usize, per_request_capacity: usize) -> Self {
		assert!(shard_count > 0, "shard count must be greater than zero");
		assert!(
			per_request_capacity > 0,
			"per-request capacity must be greater than zero"
		);

		Self {
			shard_count,
			per_request_capacity,
		}
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeliveredFrame {
	pub request_id: RequestId,
	pub frame: protocol::TunnelFrame,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RequestPressure {
	pub request_id: RequestId,
	pub capacity: usize,
	pub queue_depth: usize,
	pub credit: usize,
	pub oldest_age: Option<Duration>,
	pub dropped_frames: u64,
}

#[derive(Debug)]
pub struct ShardedReceiver {
	per_request_capacity: usize,
	shards: Vec<ReceiverShard>,
}

impl ShardedReceiver {
	pub fn new(config: FabricConfig) -> Self {
		Self {
			per_request_capacity: config.per_request_capacity,
			shards: (0..config.shard_count)
				.map(|_| ReceiverShard::default())
				.collect(),
		}
	}

	pub fn enqueue_wave(&mut self, wave: &protocol::TickWave) -> Vec<RequestPressure> {
		let mut pressures = Vec::with_capacity(wave.frames.len());

		for frame in &wave.frames {
			let shard_index = self.shard_index(frame.request_id);
			let pressure =
				self.shards[shard_index].enqueue(frame.clone(), self.per_request_capacity);
			pressures.push(pressure);
		}

		pressures
	}

	pub fn drain_ready(&mut self, max_frames: usize) -> Vec<DeliveredFrame> {
		let mut delivered = Vec::new();
		if max_frames == 0 {
			return delivered;
		}

		while delivered.len() < max_frames {
			let mut made_progress = false;

			for shard in &mut self.shards {
				if delivered.len() == max_frames {
					break;
				}
				if let Some(frame) = shard.drain_one() {
					delivered.push(frame);
					made_progress = true;
				}
			}

			if !made_progress {
				break;
			}
		}

		delivered
	}

	pub fn pop_for_request(&mut self, request_id: RequestId) -> Option<DeliveredFrame> {
		let capacity = self.per_request_capacity;
		let shard_index = self.shard_index(request_id);
		self.shards[shard_index]
			.queue_mut(request_id, capacity)
			.frames
			.pop_front()
			.map(|queued| DeliveredFrame {
				request_id,
				frame: queued.frame,
			})
	}

	pub fn pressure(&mut self, request_id: RequestId) -> RequestPressure {
		let capacity = self.per_request_capacity;
		let shard_index = self.shard_index(request_id);
		self.shards[shard_index]
			.queue_mut(request_id, capacity)
			.pressure(request_id, capacity)
	}

	fn shard_index(&self, request_id: RequestId) -> usize {
		u32::from_le_bytes(request_id) as usize % self.shards.len()
	}
}

#[derive(Default, Debug)]
struct ReceiverShard {
	queues: BTreeMap<RequestId, RequestQueue>,
	order: Vec<RequestId>,
	next_index: usize,
}

impl ReceiverShard {
	fn enqueue(&mut self, frame: protocol::TunnelFrame, capacity: usize) -> RequestPressure {
		let request_id = frame.request_id;
		let queue = self.queue_mut(request_id, capacity);
		queue.frames.push_back(QueuedFrame {
			frame,
			enqueued_at: Instant::now(),
		});
		if queue.frames.len() > capacity {
			queue.frames.pop_front();
			queue.dropped_frames += 1;
		}

		queue.pressure(request_id, capacity)
	}

	fn drain_one(&mut self) -> Option<DeliveredFrame> {
		if self.order.is_empty() {
			return None;
		}

		let len = self.order.len();
		for offset in 0..len {
			let index = (self.next_index + offset) % len;
			let request_id = self.order[index];
			let queue = self.queues.get_mut(&request_id)?;
			if let Some(queued) = queue.frames.pop_front() {
				self.next_index = (index + 1) % len;
				return Some(DeliveredFrame {
					request_id,
					frame: queued.frame,
				});
			}
		}

		None
	}

	fn queue_mut(&mut self, request_id: RequestId, capacity: usize) -> &mut RequestQueue {
		if !self.queues.contains_key(&request_id) {
			self.order.push(request_id);
		}

		self.queues
			.entry(request_id)
			.or_insert_with(|| RequestQueue::new(capacity))
	}
}

#[derive(Debug)]
struct RequestQueue {
	frames: VecDeque<QueuedFrame>,
	dropped_frames: u64,
}

impl RequestQueue {
	fn new(capacity: usize) -> Self {
		Self {
			frames: VecDeque::with_capacity(capacity),
			dropped_frames: 0,
		}
	}

	fn pressure(&self, request_id: RequestId, capacity: usize) -> RequestPressure {
		RequestPressure {
			request_id,
			capacity,
			queue_depth: self.frames.len(),
			credit: capacity.saturating_sub(self.frames.len()),
			oldest_age: self.frames.front().map(|frame| frame.enqueued_at.elapsed()),
			dropped_frames: self.dropped_frames,
		}
	}
}

#[derive(Debug)]
struct QueuedFrame {
	frame: protocol::TunnelFrame,
	enqueued_at: Instant,
}
