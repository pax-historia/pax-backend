use std::collections::HashMap;
use std::sync::{
	Arc, Mutex,
	atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use tokio::sync::mpsc;
use universalpubsub::driver::{PubSubDriver, SubscriberDriver, SubscriberDriverHandle};
use universalpubsub::metrics;
use universalpubsub::pubsub::DriverOutput;
use universalpubsub::{
	LaneOrdering, LanePriority, LanePublishOpts, LaneSpec, MessageLane, MessageLaneScheduler,
	NextOutput, OnFull, PubSub,
};

fn setup_logging() {
	let _ = tracing_subscriber::fmt()
		.with_env_filter("debug")
		.with_ansi(false)
		.with_test_writer()
		.try_init();
}

fn lane_spec(capacity: usize, on_full: OnFull, ordering: LaneOrdering) -> LaneSpec {
	lane_spec_with_priority(capacity, on_full, ordering, LanePriority::High)
}

fn lane_spec_with_priority(
	capacity: usize,
	on_full: OnFull,
	ordering: LaneOrdering,
	priority: LanePriority,
) -> LaneSpec {
	LaneSpec {
		capacity,
		on_full,
		ordering,
		local_fast_path: true,
		priority,
	}
}

fn unique_lane_name(prefix: &str) -> String {
	static NEXT_LANE_ID: AtomicUsize = AtomicUsize::new(0);
	let id = NEXT_LANE_ID.fetch_add(1, Ordering::SeqCst);
	format!("{prefix}-{id}")
}

#[test]
fn planned_consumer_presets_match_lane_policy() {
	setup_logging();

	let tunnel = LaneSpec::tunnel_v2(256);
	assert_eq!(tunnel.capacity, 256);
	assert_eq!(tunnel.on_full, OnFull::DropOldest);
	assert_eq!(tunnel.ordering, LaneOrdering::PerPartitionKey);
	assert!(tunnel.local_fast_path);
	assert_eq!(tunnel.priority, LanePriority::High);

	let gasoline = LaneSpec::gasoline_ephemeral(64);
	assert_eq!(gasoline.capacity, 64);
	assert_eq!(gasoline.on_full, OnFull::DropOldest);
	assert_eq!(gasoline.ordering, LaneOrdering::PerPartitionKey);
	assert!(!gasoline.local_fast_path);
	assert_eq!(gasoline.priority, LanePriority::Low);

	let cache = LaneSpec::cache_invalidation(32);
	assert_eq!(cache.capacity, 32);
	assert_eq!(cache.on_full, OnFull::Block);
	assert_eq!(cache.ordering, LaneOrdering::PerSubject);
	assert!(!cache.local_fast_path);
	assert_eq!(cache.priority, LanePriority::High);
}

#[derive(Default)]
struct RecordingDriver {
	publish_count: AtomicUsize,
	subscribers: Mutex<HashMap<String, Vec<mpsc::UnboundedSender<Vec<u8>>>>>,
}

#[async_trait]
impl PubSubDriver for RecordingDriver {
	async fn subscribe(&self, subject: &str) -> Result<SubscriberDriverHandle> {
		let (tx, rx) = mpsc::unbounded_channel();
		self.subscribers
			.lock()
			.unwrap()
			.entry(subject.to_string())
			.or_default()
			.push(tx);

		Ok(Box::new(RecordingSubscriber {
			subject: subject.to_string(),
			rx,
		}))
	}

	async fn queue_subscribe(&self, subject: &str, _queue: &str) -> Result<SubscriberDriverHandle> {
		self.subscribe(subject).await
	}

	async fn publish(&self, subject: &str, message: &[u8]) -> Result<()> {
		self.publish_count.fetch_add(1, Ordering::SeqCst);

		if let Some(subscribers) = self.subscribers.lock().unwrap().get(subject) {
			for subscriber in subscribers {
				let _ = subscriber.send(message.to_vec());
			}
		}

		Ok(())
	}

	async fn flush(&self) -> Result<()> {
		Ok(())
	}

	fn max_message_size(&self) -> usize {
		1024 * 1024
	}
}

async fn wait_for_publish_count(driver: &RecordingDriver, expected: usize) {
	tokio::time::timeout(Duration::from_secs(1), async {
		loop {
			if driver.publish_count.load(Ordering::SeqCst) >= expected {
				return;
			}
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("timed out waiting for recording driver publishes");
}

struct RecordingSubscriber {
	subject: String,
	rx: mpsc::UnboundedReceiver<Vec<u8>>,
}

#[async_trait]
impl SubscriberDriver for RecordingSubscriber {
	async fn next(&mut self) -> Result<DriverOutput> {
		match self.rx.recv().await {
			Some(payload) => Ok(DriverOutput::Message {
				subject: self.subject.clone(),
				payload,
			}),
			None => Ok(DriverOutput::Unsubscribed),
		}
	}
}

#[tokio::test]
async fn drop_oldest_keeps_the_newest_messages() {
	setup_logging();

	let lane = MessageLane::new(lane_spec(2, OnFull::DropOldest, LaneOrdering::PerSubject))
		.expect("lane spec should be valid");

	assert!(
		lane.publish("subject", b"one".to_vec(), LanePublishOpts::default())
			.await
			.accepted
	);
	assert!(
		lane.publish("subject", b"two".to_vec(), LanePublishOpts::default())
			.await
			.accepted
	);
	let outcome = lane
		.publish("subject", b"three".to_vec(), LanePublishOpts::default())
		.await;

	assert!(outcome.accepted);
	assert_eq!(outcome.dropped_messages, 1);
	assert_eq!(outcome.pressure.queue_depth, 2);
	assert_eq!(outcome.pressure.dropped_messages, 1);

	let first = lane.try_next().expect("expected second message");
	let second = lane.try_next().expect("expected third message");

	assert_eq!(first.payload, b"two");
	assert_eq!(first.sequence, Some(1));
	assert_eq!(second.payload, b"three");
	assert_eq!(second.sequence, Some(2));
	assert!(lane.try_next().is_none());
}

#[tokio::test]
async fn drop_newest_rejects_new_messages_when_full() {
	setup_logging();

	let lane = MessageLane::new(lane_spec(1, OnFull::DropNewest, LaneOrdering::PerSubject))
		.expect("lane spec should be valid");

	assert!(
		lane.publish("subject", b"kept".to_vec(), LanePublishOpts::default())
			.await
			.accepted
	);

	let outcome = lane
		.publish("subject", b"dropped".to_vec(), LanePublishOpts::default())
		.await;

	assert!(!outcome.accepted);
	assert_eq!(outcome.dropped_messages, 1);
	assert!(!outcome.signaled_full);
	assert_eq!(outcome.pressure.queue_depth, 1);
	assert_eq!(outcome.pressure.dropped_messages, 1);

	let message = lane.try_next().expect("expected original message");
	assert_eq!(message.payload, b"kept");
	assert_eq!(message.sequence, Some(0));
	assert!(lane.try_next().is_none());
}

#[tokio::test]
async fn signal_reports_full_without_dropping_existing_message() {
	setup_logging();

	let lane = MessageLane::new(lane_spec(1, OnFull::Signal, LaneOrdering::PerSubject))
		.expect("lane spec should be valid");

	assert!(
		lane.publish("subject", b"kept".to_vec(), LanePublishOpts::default())
			.await
			.accepted
	);

	let outcome = lane
		.publish("subject", b"rejected".to_vec(), LanePublishOpts::default())
		.await;

	assert!(!outcome.accepted);
	assert_eq!(outcome.dropped_messages, 0);
	assert!(outcome.signaled_full);
	assert_eq!(outcome.pressure.queue_depth, 1);
	assert_eq!(outcome.pressure.dropped_messages, 0);
	assert_eq!(outcome.pressure.rejected_messages, 1);

	let message = lane.try_next().expect("expected original message");
	assert_eq!(message.payload, b"kept");
	assert_eq!(message.sequence, Some(0));
	assert!(lane.try_next().is_none());
}

#[tokio::test]
async fn block_waits_for_capacity() {
	setup_logging();

	let lane = MessageLane::new(lane_spec(1, OnFull::Block, LaneOrdering::PerSubject))
		.expect("lane spec should be valid");

	assert!(
		lane.publish("subject", b"first".to_vec(), LanePublishOpts::default())
			.await
			.accepted
	);

	let publish_task = {
		let lane = lane.clone();
		tokio::spawn(async move {
			lane.publish("subject", b"second".to_vec(), LanePublishOpts::default())
				.await
		})
	};

	tokio::time::sleep(Duration::from_millis(50)).await;
	assert!(
		!publish_task.is_finished(),
		"publish should wait while capacity is full"
	);

	let first = lane.try_next().expect("expected first message");
	assert_eq!(first.payload, b"first");

	let outcome = tokio::time::timeout(Duration::from_secs(1), publish_task)
		.await
		.expect("blocked publish should complete")
		.expect("publish task should not panic");
	assert!(outcome.accepted);
	assert_eq!(outcome.pressure.queue_depth, 1);

	let second = lane.try_next().expect("expected second message");
	assert_eq!(second.payload, b"second");
	assert_eq!(second.sequence, Some(1));
}

#[tokio::test]
async fn partition_sequences_are_independent() {
	setup_logging();

	let lane = MessageLane::new(lane_spec(8, OnFull::Block, LaneOrdering::PerPartitionKey))
		.expect("lane spec should be valid");

	lane.publish(
		"subject",
		b"a-0".to_vec(),
		LanePublishOpts::partition_key("gateway-a"),
	)
	.await;
	lane.publish(
		"subject",
		b"b-0".to_vec(),
		LanePublishOpts::partition_key("gateway-b"),
	)
	.await;
	lane.publish(
		"subject",
		b"a-1".to_vec(),
		LanePublishOpts::partition_key("gateway-a"),
	)
	.await;

	let a0 = lane.try_next().expect("expected a-0");
	let b0 = lane.try_next().expect("expected b-0");
	let a1 = lane.try_next().expect("expected a-1");

	assert_eq!(a0.sequence, Some(0));
	assert_eq!(b0.sequence, Some(0));
	assert_eq!(a1.sequence, Some(1));
}

#[tokio::test]
async fn none_ordering_omits_sequence_numbers() {
	setup_logging();

	let lane = MessageLane::new(lane_spec(2, OnFull::Block, LaneOrdering::None))
		.expect("lane spec should be valid");

	lane.publish("subject", b"one".to_vec(), LanePublishOpts::default())
		.await;
	let message = lane.try_next().expect("expected message");

	assert_eq!(message.sequence, None);
}

#[tokio::test]
async fn lane_metrics_track_depth_and_drops() {
	setup_logging();

	let lane_name = unique_lane_name("metrics-drop-oldest");
	let lane = MessageLane::named(
		lane_name.clone(),
		lane_spec(1, OnFull::DropOldest, LaneOrdering::PerSubject),
	)
	.expect("lane spec should be valid");

	lane.publish("subject", b"one".to_vec(), LanePublishOpts::default())
		.await;
	lane.publish("subject", b"two".to_vec(), LanePublishOpts::default())
		.await;

	assert_eq!(
		metrics::LANE_QUEUE_DEPTH
			.with_label_values(&[lane_name.as_str()])
			.get(),
		1
	);
	assert_eq!(
		metrics::LANE_DROPPED_MESSAGE_COUNT
			.with_label_values(&[lane_name.as_str(), OnFull::DropOldest.as_label()])
			.get(),
		1
	);
	assert_eq!(
		metrics::LANE_PUBLISH_COUNT
			.with_label_values(&[lane_name.as_str(), "accepted"])
			.get(),
		2
	);

	let message = lane.try_next().expect("expected queued message");
	assert_eq!(message.payload, b"two");
	assert_eq!(
		metrics::LANE_QUEUE_DEPTH
			.with_label_values(&[lane_name.as_str()])
			.get(),
		0
	);
}

#[tokio::test]
async fn scheduler_drains_high_before_normal_before_low() {
	setup_logging();

	let low = MessageLane::named(
		unique_lane_name("scheduler-low"),
		lane_spec_with_priority(
			8,
			OnFull::Block,
			LaneOrdering::PerSubject,
			LanePriority::Low,
		),
	)
	.expect("low lane spec should be valid");
	let normal = MessageLane::named(
		unique_lane_name("scheduler-normal"),
		lane_spec_with_priority(
			8,
			OnFull::Block,
			LaneOrdering::PerSubject,
			LanePriority::Normal,
		),
	)
	.expect("normal lane spec should be valid");
	let high = MessageLane::named(
		unique_lane_name("scheduler-high"),
		lane_spec_with_priority(
			8,
			OnFull::Block,
			LaneOrdering::PerSubject,
			LanePriority::High,
		),
	)
	.expect("high lane spec should be valid");

	let scheduler = MessageLaneScheduler::new([low.clone(), normal.clone(), high.clone()]);

	low.publish("subject", b"low".to_vec(), LanePublishOpts::default())
		.await;
	normal
		.publish("subject", b"normal".to_vec(), LanePublishOpts::default())
		.await;
	high.publish("subject", b"high".to_vec(), LanePublishOpts::default())
		.await;

	let first = scheduler.next().await;
	let second = scheduler.next().await;
	let third = scheduler.next().await;

	assert_eq!(first.priority, LanePriority::High);
	assert_eq!(first.lane_name, high.name());
	assert_eq!(first.message.payload, b"high");
	assert_eq!(second.priority, LanePriority::Normal);
	assert_eq!(second.lane_name, normal.name());
	assert_eq!(second.message.payload, b"normal");
	assert_eq!(third.priority, LanePriority::Low);
	assert_eq!(third.lane_name, low.name());
	assert_eq!(third.message.payload, b"low");
}

#[tokio::test]
async fn scheduler_round_robins_within_the_same_priority() {
	setup_logging();

	let first_lane = MessageLane::named(
		unique_lane_name("scheduler-first-high"),
		lane_spec_with_priority(
			8,
			OnFull::Block,
			LaneOrdering::PerSubject,
			LanePriority::High,
		),
	)
	.expect("first lane spec should be valid");
	let second_lane = MessageLane::named(
		unique_lane_name("scheduler-second-high"),
		lane_spec_with_priority(
			8,
			OnFull::Block,
			LaneOrdering::PerSubject,
			LanePriority::High,
		),
	)
	.expect("second lane spec should be valid");

	let scheduler = MessageLaneScheduler::new([first_lane.clone(), second_lane.clone()]);

	first_lane
		.publish("subject", b"first-0".to_vec(), LanePublishOpts::default())
		.await;
	first_lane
		.publish("subject", b"first-1".to_vec(), LanePublishOpts::default())
		.await;
	second_lane
		.publish("subject", b"second-0".to_vec(), LanePublishOpts::default())
		.await;

	let first = scheduler.next().await;
	let second = scheduler.next().await;
	let third = scheduler.next().await;

	assert_eq!(first.lane_name, first_lane.name());
	assert_eq!(first.message.payload, b"first-0");
	assert_eq!(second.lane_name, second_lane.name());
	assert_eq!(second.message.payload, b"second-0");
	assert_eq!(third.lane_name, first_lane.name());
	assert_eq!(third.message.payload, b"first-1");
}

#[tokio::test]
async fn scheduler_waits_until_a_lane_is_published() {
	setup_logging();

	let lane = MessageLane::named(
		unique_lane_name("scheduler-wait"),
		lane_spec_with_priority(
			8,
			OnFull::Block,
			LaneOrdering::PerSubject,
			LanePriority::Normal,
		),
	)
	.expect("lane spec should be valid");
	let scheduler = MessageLaneScheduler::new([lane.clone()]);

	let next_task = {
		let scheduler = scheduler.clone();
		tokio::spawn(async move { scheduler.next().await })
	};

	tokio::time::sleep(Duration::from_millis(50)).await;
	assert!(
		!next_task.is_finished(),
		"scheduler should wait while all lanes are empty"
	);

	lane.publish("subject", b"awake".to_vec(), LanePublishOpts::default())
		.await;

	let scheduled = tokio::time::timeout(Duration::from_secs(1), next_task)
		.await
		.expect("scheduler should wake after publish")
		.expect("scheduler task should not panic");
	assert_eq!(scheduled.priority, LanePriority::Normal);
	assert_eq!(scheduled.message.payload, b"awake");
}

#[test]
fn zero_capacity_lane_is_rejected() {
	setup_logging();

	let err = match MessageLane::new(lane_spec(0, OnFull::Block, LaneOrdering::PerSubject)) {
		Ok(_) => panic!("zero capacity should be invalid"),
		Err(err) => err,
	};

	assert_eq!(err.to_string(), "lane capacity must be greater than zero");
}

#[tokio::test]
async fn pubsub_lane_local_fast_path_skips_driver_publish() {
	setup_logging();

	let driver = Arc::new(RecordingDriver::default());
	let pubsub = PubSub::new_with_memory_optimization(driver.clone(), true);
	let lane = pubsub
		.lane(lane_spec(8, OnFull::Block, LaneOrdering::PerSubject))
		.expect("lane spec should be valid");
	let mut subscriber = lane
		.subscribe("lane.local")
		.await
		.expect("subscribe should succeed");

	let outcome = lane
		.publish("lane.local", b"local".to_vec(), LanePublishOpts::default())
		.await;
	assert!(outcome.accepted);

	let received = tokio::time::timeout(Duration::from_secs(1), subscriber.next())
		.await
		.expect("subscriber should receive local lane message")
		.expect("subscriber should not error");
	match received {
		NextOutput::Message(message) => assert_eq!(message.payload, b"local"),
		NextOutput::Unsubscribed => panic!("subscriber unexpectedly unsubscribed"),
	}

	assert_eq!(
		driver.publish_count.load(Ordering::SeqCst),
		0,
		"local-fast-path lane should skip the underlying driver"
	);
}

#[tokio::test]
async fn pubsub_lane_without_local_fast_path_uses_driver_publish() {
	setup_logging();

	let driver = Arc::new(RecordingDriver::default());
	let pubsub = PubSub::new_with_memory_optimization(driver.clone(), true);
	let mut spec = lane_spec(8, OnFull::Block, LaneOrdering::PerSubject);
	spec.local_fast_path = false;
	let lane = pubsub.lane(spec).expect("lane spec should be valid");
	let mut subscriber = lane
		.subscribe("lane.driver")
		.await
		.expect("subscribe should succeed");

	let outcome = lane
		.publish(
			"lane.driver",
			b"driver".to_vec(),
			LanePublishOpts::default(),
		)
		.await;
	assert!(outcome.accepted);

	let received = tokio::time::timeout(Duration::from_secs(1), subscriber.next())
		.await
		.expect("subscriber should receive driver lane message")
		.expect("subscriber should not error");
	match received {
		NextOutput::Message(message) => assert_eq!(message.payload, b"driver"),
		NextOutput::Unsubscribed => panic!("subscriber unexpectedly unsubscribed"),
	}

	assert_eq!(
		driver.publish_count.load(Ordering::SeqCst),
		1,
		"non-local lane should publish through the underlying driver"
	);
}

#[tokio::test]
async fn pubsub_lane_set_drains_multiple_lanes_with_one_priority_scheduler() {
	setup_logging();

	let driver = Arc::new(RecordingDriver::default());
	let pubsub = PubSub::new_with_memory_optimization(driver.clone(), false);
	let lane_set = pubsub.lane_set();
	let mut subscriber = pubsub
		.subscribe("lane.set")
		.await
		.expect("subscribe should succeed");

	let low = lane_set
		.add_lane(
			unique_lane_name("pubsub-set-low"),
			lane_spec_with_priority(
				8,
				OnFull::Block,
				LaneOrdering::PerSubject,
				LanePriority::Low,
			),
		)
		.expect("low lane spec should be valid");
	let high = lane_set
		.add_lane(
			unique_lane_name("pubsub-set-high"),
			lane_spec_with_priority(
				8,
				OnFull::Block,
				LaneOrdering::PerSubject,
				LanePriority::High,
			),
		)
		.expect("high lane spec should be valid");

	low.publish("lane.set", b"low".to_vec(), LanePublishOpts::default())
		.await;
	high.publish("lane.set", b"high".to_vec(), LanePublishOpts::default())
		.await;

	wait_for_publish_count(&driver, 2).await;

	let first = tokio::time::timeout(Duration::from_secs(1), subscriber.next())
		.await
		.expect("first scheduled message should arrive")
		.expect("subscriber should not error");
	let second = tokio::time::timeout(Duration::from_secs(1), subscriber.next())
		.await
		.expect("second scheduled message should arrive")
		.expect("subscriber should not error");

	match first {
		NextOutput::Message(message) => assert_eq!(message.payload, b"high"),
		NextOutput::Unsubscribed => panic!("subscriber unexpectedly unsubscribed"),
	}
	match second {
		NextOutput::Message(message) => assert_eq!(message.payload, b"low"),
		NextOutput::Unsubscribed => panic!("subscriber unexpectedly unsubscribed"),
	}
}
