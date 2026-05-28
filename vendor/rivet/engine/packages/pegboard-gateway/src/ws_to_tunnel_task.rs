use anyhow::Result;
use futures_util::{FutureExt, TryStreamExt};
use rivet_guard_core::websocket_handle::WebSocketReceiver;
use rivet_runner_protocol as protocol;
use std::sync::{
	Arc,
	atomic::{AtomicU64, Ordering},
};
use tokio::sync::{Mutex, watch};
use tokio_tungstenite::tungstenite::{Message, protocol::frame::CloseFrame};

use super::LifecycleResult;
use crate::shared_state::SharedState;

const MAX_WS_TUNNEL_BATCH_MESSAGES: usize = 64;

pub async fn task(
	shared_state: SharedState,
	request_id: protocol::mk2::RequestId,
	ws_rx: Arc<Mutex<WebSocketReceiver>>,
	ingress_bytes: Arc<AtomicU64>,
	mut ws_to_tunnel_abort_rx: watch::Receiver<()>,
) -> Result<LifecycleResult> {
	let mut ws_rx = ws_rx.lock().await;

	loop {
		tokio::select! {
			res = ws_rx.try_next() => {
				if let Some(msg) = res? {
					ingress_bytes.fetch_add(msg.len() as u64, Ordering::AcqRel);

					match tunnel_message_from_ws(msg) {
						WsIngress::Tunnel(first) => {
							let mut batch = vec![first];
							let mut close_after_batch = None;

							while batch.len() < MAX_WS_TUNNEL_BATCH_MESSAGES {
								let Some(next) = ws_rx.try_next().now_or_never() else {
									break;
								};

								let next = match next {
									Ok(next) => next,
									Err(err) => {
										shared_state
											.send_messages(request_id, batch)
											.await?;
										return Err(err.into());
									}
								};

								let Some(msg) = next else {
									tracing::debug!("websocket stream closed");
									close_after_batch = Some(None);
									break;
								};
								ingress_bytes.fetch_add(msg.len() as u64, Ordering::AcqRel);

								match tunnel_message_from_ws(msg) {
									WsIngress::Tunnel(next) => batch.push(next),
									WsIngress::Close(close) => {
										close_after_batch = Some(close);
										break;
									}
									WsIngress::Ignore => break,
								}
							}

							shared_state.send_messages(request_id, batch).await?;

							if let Some(close) = close_after_batch {
								return Ok(LifecycleResult::ClientClose(close));
							}
						}
						WsIngress::Close(close) => {
							return Ok(LifecycleResult::ClientClose(close));
						}
						WsIngress::Ignore => {}
					}
				} else {
					tracing::debug!("websocket stream closed");
					return Ok(LifecycleResult::ClientClose(None));
				}
			}
			_ = ws_to_tunnel_abort_rx.changed() => {
				tracing::debug!("task aborted");
				return Ok(LifecycleResult::Aborted);
			}
		};
	}
}

enum WsIngress {
	Tunnel(protocol::mk2::ToClientTunnelMessageKind),
	Close(Option<CloseFrame>),
	Ignore,
}

fn tunnel_message_from_ws(msg: Message) -> WsIngress {
	match msg {
		Message::Binary(data) => WsIngress::Tunnel(
			protocol::mk2::ToClientTunnelMessageKind::ToClientWebSocketMessage(
				protocol::mk2::ToClientWebSocketMessage {
					data: data.into(),
					binary: true,
				},
			),
		),
		Message::Text(text) => WsIngress::Tunnel(
			protocol::mk2::ToClientTunnelMessageKind::ToClientWebSocketMessage(
				protocol::mk2::ToClientWebSocketMessage {
					data: text.as_bytes().to_vec(),
					binary: false,
				},
			),
		),
		Message::Close(close) => WsIngress::Close(close),
		_ => WsIngress::Ignore,
	}
}
