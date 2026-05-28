use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::Subject;
use crate::driver::PublishOpts;
use crate::metrics;
use crate::pubsub::{PubSub, Subscriber};

const DEFAULT_LANE_NAME: &str = "anonymous";

/// Bounded queue behavior when a lane is full.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OnFull {
	/// Remove the oldest queued message and enqueue the new message.
	DropOldest,
	/// Drop the new message and keep the queued messages unchanged.
	DropNewest,
	/// Wait until queue capacity is available.
	Block,
	/// Reject the new message and report pressure to the caller.
	Signal,
}

impl OnFull {
	pub const fn as_label(&self) -> &'static str {
		match self {
			OnFull::DropOldest => "drop_oldest",
			OnFull::DropNewest => "drop_newest",
			OnFull::Block => "block",
			OnFull::Signal => "signal",
		}
	}
}

/// Ordering contract provided by a lane.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LaneOrdering {
	/// Preserve sequence numbers independently for each subject.
	PerSubject,
	/// Preserve sequence numbers independently for each caller-provided partition key.
	PerPartitionKey,
	/// Do not assign sequence numbers.
	None,
}

/// Scheduler priority hint for a lane.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LanePriority {
	High,
	Normal,
	Low,
}

impl LanePriority {
	const ORDERED: [Self; 3] = [Self::High, Self::Normal, Self::Low];

	const fn index(&self) -> usize {
		match self {
			LanePriority::High => 0,
			LanePriority::Normal => 1,
			LanePriority::Low => 2,
		}
	}

	pub const fn as_label(&self) -> &'static str {
		match self {
			LanePriority::High => "high",
			LanePriority::Normal => "normal",
			LanePriority::Low => "low",
		}
	}
}

/// Policy for a message lane.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaneSpec {
	pub capacity: usize,
	pub on_full: OnFull,
	pub ordering: LaneOrdering,
	pub local_fast_path: bool,
	pub priority: LanePriority,
}

impl LaneSpec {
	pub const fn new(capacity: usize) -> Self {
		Self {
			capacity,
			on_full: OnFull::Block,
			ordering: LaneOrdering::PerSubject,
			local_fast_path: false,
			priority: LanePriority::Normal,
		}
	}

	pub const fn tunnel_v2(capacity: usize) -> Self {
		Self {
			capacity,
			on_full: OnFull::DropOldest,
			ordering: LaneOrdering::PerPartitionKey,
			local_fast_path: true,
			priority: LanePriority::High,
		}
	}

	pub const fn gasoline_ephemeral(capacity: usize) -> Self {
		Self {
			capacity,
			on_full: OnFull::DropOldest,
			ordering: LaneOrdering::PerPartitionKey,
			local_fast_path: false,
			priority: LanePriority::Low,
		}
	}

	pub const fn cache_invalidation(capacity: usize) -> Self {
		Self {
			capacity,
			on_full: OnFull::Block,
			ordering: LaneOrdering::PerSubject,
			local_fast_path: false,
			priority: LanePriority::High,
		}
	}

	pub fn validate(&self) -> Result<(), LaneSpecError> {
		if self.capacity == 0 {
			return Err(LaneSpecError::ZeroCapacity);
		}

		Ok(())
	}
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum LaneSpecError {
	ZeroCapacity,
}

impl fmt::Display for LaneSpecError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			LaneSpecError::ZeroCapacity => write!(f, "lane capacity must be greater than zero"),
		}
	}
}

impl std::error::Error for LaneSpecError {}

/// Per-publish lane hints.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct LanePublishOpts {
	pub partition_key: Option<String>,
}

impl LanePublishOpts {
	pub fn partition_key(partition_key: impl Into<String>) -> Self {
		Self {
			partition_key: Some(partition_key.into()),
		}
	}
}

/// A message accepted by a lane.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LaneMessage {
	pub subject: String,
	pub payload: Vec<u8>,
	pub partition_key: Option<String>,
	pub sequence: Option<u64>,
	pub enqueued_at: Instant,
}

/// Point-in-time pressure snapshot for a lane.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LanePressure {
	pub capacity: usize,
	pub queue_depth: usize,
	pub oldest_age: Option<Duration>,
	pub dropped_messages: u64,
	pub rejected_messages: u64,
}

/// Result of a lane publish attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LanePublishOutcome {
	pub accepted: bool,
	pub dropped_messages: u64,
	pub signaled_full: bool,
	pub pressure: LanePressure,
}

#[derive(Clone)]
pub struct MessageLane {
	inner: Arc<MessageLaneInner>,
}

struct MessageLaneInner {
	name: String,
	spec: LaneSpec,
	state: Mutex<LaneState>,
	not_empty: Notify,
	not_full: Notify,
	scheduler_notifies: Mutex<Vec<Arc<Notify>>>,
}

#[derive(Default)]
struct LaneState {
	queue: VecDeque<LaneMessage>,
	next_sequence: HashMap<String, u64>,
	dropped_messages: u64,
	rejected_messages: u64,
}

impl MessageLane {
	pub fn new(spec: LaneSpec) -> Result<Self, LaneSpecError> {
		Self::named(DEFAULT_LANE_NAME, spec)
	}

	pub fn named(name: impl Into<String>, spec: LaneSpec) -> Result<Self, LaneSpecError> {
		spec.validate()?;

		let lane = Self {
			inner: Arc::new(MessageLaneInner {
				name: name.into(),
				spec,
				state: Mutex::new(LaneState::default()),
				not_empty: Notify::new(),
				not_full: Notify::new(),
				scheduler_notifies: Mutex::new(Vec::new()),
			}),
		};
		lane.record_metrics(&LaneState::default());

		Ok(lane)
	}

	pub fn name(&self) -> &str {
		&self.inner.name
	}

	pub fn spec(&self) -> &LaneSpec {
		&self.inner.spec
	}

	fn register_scheduler_notify(&self, notify: Arc<Notify>) {
		self.inner.scheduler_notifies.lock().unwrap().push(notify);
	}

	pub async fn publish(
		&self,
		subject: impl Into<String>,
		payload: impl Into<Vec<u8>>,
		opts: LanePublishOpts,
	) -> LanePublishOutcome {
		let mut subject = Some(subject.into());
		let mut payload = Some(payload.into());
		let mut opts = Some(opts);

		loop {
			let notified = self.inner.not_full.notified();

			{
				let mut state = self.inner.state.lock().unwrap();

				if state.queue.len() < self.inner.spec.capacity {
					let message = self.build_message(
						&mut state,
						subject.take().unwrap(),
						payload.take().unwrap(),
						opts.take().unwrap(),
					);
					state.queue.push_back(message);
					let pressure = self.pressure_from_state(&state);
					self.record_metrics(&state);
					metrics::LANE_PUBLISH_COUNT
						.with_label_values(&[self.name(), "accepted"])
						.inc();
					self.notify_message_available();
					return LanePublishOutcome {
						accepted: true,
						dropped_messages: 0,
						signaled_full: false,
						pressure,
					};
				}

				match self.inner.spec.on_full {
					OnFull::DropOldest => {
						state.queue.pop_front();
						state.dropped_messages += 1;
						let message = self.build_message(
							&mut state,
							subject.take().unwrap(),
							payload.take().unwrap(),
							opts.take().unwrap(),
						);
						state.queue.push_back(message);
						let pressure = self.pressure_from_state(&state);
						self.record_metrics(&state);
						metrics::LANE_DROPPED_MESSAGE_COUNT
							.with_label_values(&[self.name(), self.inner.spec.on_full.as_label()])
							.inc();
						metrics::LANE_PUBLISH_COUNT
							.with_label_values(&[self.name(), "accepted"])
							.inc();
						self.notify_message_available();
						return LanePublishOutcome {
							accepted: true,
							dropped_messages: 1,
							signaled_full: false,
							pressure,
						};
					}
					OnFull::DropNewest => {
						state.dropped_messages += 1;
						let pressure = self.pressure_from_state(&state);
						self.record_metrics(&state);
						metrics::LANE_DROPPED_MESSAGE_COUNT
							.with_label_values(&[self.name(), self.inner.spec.on_full.as_label()])
							.inc();
						metrics::LANE_PUBLISH_COUNT
							.with_label_values(&[self.name(), "dropped_newest"])
							.inc();
						return LanePublishOutcome {
							accepted: false,
							dropped_messages: 1,
							signaled_full: false,
							pressure,
						};
					}
					OnFull::Signal => {
						state.rejected_messages += 1;
						let pressure = self.pressure_from_state(&state);
						self.record_metrics(&state);
						metrics::LANE_REJECTED_MESSAGE_COUNT
							.with_label_values(&[self.name()])
							.inc();
						metrics::LANE_PUBLISH_COUNT
							.with_label_values(&[self.name(), "signaled_full"])
							.inc();
						return LanePublishOutcome {
							accepted: false,
							dropped_messages: 0,
							signaled_full: true,
							pressure,
						};
					}
					OnFull::Block => {}
				}
			}

			notified.await;
		}
	}

	pub async fn next(&self) -> LaneMessage {
		loop {
			let notified = self.inner.not_empty.notified();
			if let Some(message) = self.try_next() {
				return message;
			}
			notified.await;
		}
	}

	pub fn try_next(&self) -> Option<LaneMessage> {
		let mut state = self.inner.state.lock().unwrap();
		let message = state.queue.pop_front();
		if message.is_some() {
			self.record_metrics(&state);
			drop(state);
			self.inner.not_full.notify_one();
		}
		message
	}

	pub fn pressure(&self) -> LanePressure {
		let state = self.inner.state.lock().unwrap();
		self.pressure_from_state(&state)
	}

	fn build_message(
		&self,
		state: &mut LaneState,
		subject: String,
		payload: Vec<u8>,
		opts: LanePublishOpts,
	) -> LaneMessage {
		let sequence = self.sequence_for_message(state, &subject, opts.partition_key.as_deref());

		LaneMessage {
			subject,
			payload,
			partition_key: opts.partition_key,
			sequence,
			enqueued_at: Instant::now(),
		}
	}

	fn sequence_for_message(
		&self,
		state: &mut LaneState,
		subject: &str,
		partition_key: Option<&str>,
	) -> Option<u64> {
		let key = match self.inner.spec.ordering {
			LaneOrdering::PerSubject => subject,
			LaneOrdering::PerPartitionKey => partition_key.unwrap_or(subject),
			LaneOrdering::None => return None,
		};

		let sequence = state.next_sequence.entry(key.to_string()).or_default();
		let current = *sequence;
		*sequence += 1;
		Some(current)
	}

	fn pressure_from_state(&self, state: &LaneState) -> LanePressure {
		LanePressure {
			capacity: self.inner.spec.capacity,
			queue_depth: state.queue.len(),
			oldest_age: state
				.queue
				.front()
				.map(|message| message.enqueued_at.elapsed()),
			dropped_messages: state.dropped_messages,
			rejected_messages: state.rejected_messages,
		}
	}

	fn record_metrics(&self, state: &LaneState) {
		metrics::LANE_QUEUE_DEPTH
			.with_label_values(&[self.name()])
			.set(state.queue.len() as i64);
		metrics::LANE_OLDEST_AGE_SECONDS
			.with_label_values(&[self.name()])
			.set(
				state
					.queue
					.front()
					.map(|message| message.enqueued_at.elapsed().as_secs_f64())
					.unwrap_or(0.0),
			);
	}

	fn notify_message_available(&self) {
		self.inner.not_empty.notify_one();

		for notify in self.inner.scheduler_notifies.lock().unwrap().iter() {
			notify.notify_one();
		}
	}
}

#[derive(Clone)]
pub struct MessageLaneScheduler {
	inner: Arc<MessageLaneSchedulerInner>,
}

struct MessageLaneSchedulerInner {
	lanes: Mutex<Vec<MessageLane>>,
	priority_cursors: Mutex<[usize; 3]>,
	not_empty: Arc<Notify>,
}

pub struct ScheduledLaneMessage {
	pub lane_name: String,
	pub priority: LanePriority,
	pub local_fast_path: bool,
	pub message: LaneMessage,
}

impl MessageLaneScheduler {
	pub fn new(lanes: impl IntoIterator<Item = MessageLane>) -> Self {
		let scheduler = Self {
			inner: Arc::new(MessageLaneSchedulerInner {
				lanes: Mutex::new(Vec::new()),
				priority_cursors: Mutex::new([0, 0, 0]),
				not_empty: Arc::new(Notify::new()),
			}),
		};

		for lane in lanes {
			scheduler.add_lane(lane);
		}

		scheduler
	}

	pub fn add_lane(&self, lane: MessageLane) {
		lane.register_scheduler_notify(self.inner.not_empty.clone());
		self.inner.lanes.lock().unwrap().push(lane);
		self.inner.not_empty.notify_one();
	}

	pub async fn next(&self) -> ScheduledLaneMessage {
		loop {
			let notified = self.inner.not_empty.notified();
			if let Some(message) = self.try_next() {
				return message;
			}
			notified.await;
		}
	}

	pub fn try_next(&self) -> Option<ScheduledLaneMessage> {
		let lanes = self.inner.lanes.lock().unwrap();
		let mut priority_cursors = self.inner.priority_cursors.lock().unwrap();

		for priority in LanePriority::ORDERED {
			let matching_indices = lanes
				.iter()
				.enumerate()
				.filter_map(|(idx, lane)| (lane.spec().priority == priority).then_some(idx))
				.collect::<Vec<_>>();
			if matching_indices.is_empty() {
				continue;
			}

			let cursor_slot = priority.index();
			let cursor = priority_cursors[cursor_slot] % matching_indices.len();

			for offset in 0..matching_indices.len() {
				let local_idx = (cursor + offset) % matching_indices.len();
				let lane = &lanes[matching_indices[local_idx]];

				if let Some(message) = lane.try_next() {
					priority_cursors[cursor_slot] = (local_idx + 1) % matching_indices.len();
					return Some(ScheduledLaneMessage {
						lane_name: lane.name().to_string(),
						priority,
						local_fast_path: lane.spec().local_fast_path,
						message,
					});
				}
			}

			priority_cursors[cursor_slot] = cursor;
		}

		None
	}
}

pub struct PubSubLaneSet {
	pubsub: PubSub,
	scheduler: MessageLaneScheduler,
	cancel: CancellationToken,
}

impl PubSubLaneSet {
	pub fn new(pubsub: PubSub) -> Self {
		let scheduler = MessageLaneScheduler::new([]);
		let cancel = CancellationToken::new();

		tokio::spawn(Self::spawn_publish_worker(
			pubsub.clone(),
			scheduler.clone(),
			cancel.clone(),
		));

		Self {
			pubsub,
			scheduler,
			cancel,
		}
	}

	pub fn add_lane(
		&self,
		name: impl Into<String>,
		spec: LaneSpec,
	) -> Result<PubSubLane, LaneSpecError> {
		let buffer = MessageLane::named(name, spec)?;
		self.scheduler.add_lane(buffer.clone());
		Ok(PubSubLane::from_shared_buffer(self.pubsub.clone(), buffer))
	}

	async fn spawn_publish_worker(
		pubsub: PubSub,
		scheduler: MessageLaneScheduler,
		cancel: CancellationToken,
	) {
		loop {
			tokio::select! {
				_ = cancel.cancelled() => break,
				scheduled = scheduler.next() => {
					publish_scheduled_message(&pubsub, scheduled).await;
				}
			}
		}
	}
}

impl Drop for PubSubLaneSet {
	fn drop(&mut self) {
		self.cancel.cancel();
	}
}

pub struct PubSubLane {
	pubsub: PubSub,
	buffer: MessageLane,
	cancel: Option<CancellationToken>,
}

impl PubSubLane {
	pub fn new(pubsub: PubSub, spec: LaneSpec) -> Result<Self, LaneSpecError> {
		Self::named(DEFAULT_LANE_NAME, pubsub, spec)
	}

	pub fn named(
		name: impl Into<String>,
		pubsub: PubSub,
		spec: LaneSpec,
	) -> Result<Self, LaneSpecError> {
		let buffer = MessageLane::named(name, spec)?;
		let cancel = CancellationToken::new();

		tokio::spawn(Self::spawn_publish_worker(
			pubsub.clone(),
			buffer.clone(),
			cancel.clone(),
		));

		Ok(Self {
			pubsub,
			buffer,
			cancel: Some(cancel),
		})
	}

	fn from_shared_buffer(pubsub: PubSub, buffer: MessageLane) -> Self {
		Self {
			pubsub,
			buffer,
			cancel: None,
		}
	}

	pub fn name(&self) -> &str {
		self.buffer.name()
	}

	pub fn spec(&self) -> &LaneSpec {
		self.buffer.spec()
	}

	pub async fn publish(
		&self,
		subject: impl Into<String>,
		payload: impl Into<Vec<u8>>,
		opts: LanePublishOpts,
	) -> LanePublishOutcome {
		self.buffer.publish(subject, payload, opts).await
	}

	pub async fn subscribe<T: Subject>(&self, subject: T) -> Result<Subscriber> {
		self.pubsub.subscribe(subject).await
	}

	pub fn pressure(&self) -> LanePressure {
		self.buffer.pressure()
	}

	async fn spawn_publish_worker(pubsub: PubSub, buffer: MessageLane, cancel: CancellationToken) {
		loop {
			tokio::select! {
				_ = cancel.cancelled() => break,
				message = buffer.next() => {
					let scheduled = ScheduledLaneMessage {
						lane_name: buffer.name().to_string(),
						priority: buffer.spec().priority,
						local_fast_path: buffer.spec().local_fast_path,
						message,
					};
					publish_scheduled_message(&pubsub, scheduled).await;
				}
			}
		}
	}
}

impl Drop for PubSubLane {
	fn drop(&mut self) {
		if let Some(cancel) = &self.cancel {
			cancel.cancel();
		}
	}
}

async fn publish_scheduled_message(pubsub: &PubSub, scheduled: ScheduledLaneMessage) {
	let opts = if scheduled.local_fast_path {
		PublishOpts::one()
	} else {
		PublishOpts::broadcast()
	};

	if let Err(err) = pubsub
		.publish(&scheduled.message.subject, &scheduled.message.payload, opts)
		.await
	{
		tracing::warn!(
			?err,
			lane = %scheduled.lane_name,
			priority = scheduled.priority.as_label(),
			subject = %scheduled.message.subject,
			"failed to publish UPS lane message"
		);
	}
}

impl PubSub {
	pub fn lane(&self, spec: LaneSpec) -> Result<PubSubLane, LaneSpecError> {
		PubSubLane::new(self.clone(), spec)
	}

	pub fn named_lane(
		&self,
		name: impl Into<String>,
		spec: LaneSpec,
	) -> Result<PubSubLane, LaneSpecError> {
		PubSubLane::named(name, self.clone(), spec)
	}

	pub fn lane_set(&self) -> PubSubLaneSet {
		PubSubLaneSet::new(self.clone())
	}
}
