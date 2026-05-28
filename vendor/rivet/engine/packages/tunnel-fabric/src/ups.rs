use anyhow::{Context, Result};
use universalpubsub::{LanePublishOutcome, NextOutput, PubSubLane, Subscriber};

use crate::{
	GatewayId, RequestPressure, ShardedReceiver, gateway_partition_key, lane_publish_opts, protocol,
};

pub const SUBJECT_PREFIX: &str = "rivet.tunnel.v2.gateway";

pub fn subject_for_gateway(gateway_id: GatewayId) -> String {
	format!("{}.{}", SUBJECT_PREFIX, gateway_partition_key(gateway_id))
}

pub fn encode_wave(wave: &protocol::TickWave) -> Result<Vec<u8>> {
	serde_bare::to_vec(wave).context("failed to encode Tunnel v2 TickWave")
}

pub fn decode_wave(payload: &[u8]) -> Result<protocol::TickWave> {
	serde_bare::from_slice(payload).context("failed to decode Tunnel v2 TickWave")
}

pub struct UpsWaveLane {
	lane: PubSubLane,
}

impl UpsWaveLane {
	pub fn new(lane: PubSubLane) -> Self {
		Self { lane }
	}

	pub async fn publish_wave(&self, wave: &protocol::TickWave) -> Result<LanePublishOutcome> {
		let payload = encode_wave(wave)?;
		let subject = subject_for_gateway(wave.gateway_id);
		Ok(self
			.lane
			.publish(subject, payload, lane_publish_opts(wave.gateway_id))
			.await)
	}

	pub async fn subscribe_gateway(&self, gateway_id: GatewayId) -> Result<UpsWaveSubscriber> {
		let subject = subject_for_gateway(gateway_id);
		let subscriber = self.lane.subscribe(&subject).await?;
		Ok(UpsWaveSubscriber { subscriber })
	}
}

pub struct UpsWaveSubscriber {
	subscriber: Subscriber,
}

impl UpsWaveSubscriber {
	pub async fn next_wave(&mut self) -> Result<Option<protocol::TickWave>> {
		match self.subscriber.next().await? {
			NextOutput::Message(message) => decode_wave(&message.payload).map(Some),
			NextOutput::Unsubscribed => Ok(None),
		}
	}

	pub async fn next_into_receiver(
		&mut self,
		receiver: &mut ShardedReceiver,
	) -> Result<Option<Vec<RequestPressure>>> {
		Ok(self
			.next_wave()
			.await?
			.map(|wave| receiver.enqueue_wave(&wave)))
	}
}
