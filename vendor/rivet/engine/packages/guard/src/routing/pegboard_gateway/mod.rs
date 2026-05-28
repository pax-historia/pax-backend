mod cors;
mod resolve_actor_query;

use std::{
	sync::Arc,
	time::{Duration, Instant},
};

use anyhow::Result;
use gas::{ctx::message::SubscriptionHandle, prelude::*};
use hyper::header::HeaderName;
use pegboard::routing_directory::{
	RoutingDelta, RoutingDirectory, RoutingLookup, RoutingSnapshot, RoutingTarget,
};
use rivet_guard_core::{RouteConfig, RouteTarget, RoutingOutput, request_context::RequestContext};
use tokio::sync::watch;

use super::{
	SEC_WEBSOCKET_PROTOCOL, WS_PROTOCOL_ACTOR, WS_PROTOCOL_SKIP_READY_WAIT, WS_PROTOCOL_TOKEN,
	X_RIVET_SKIP_READY_WAIT, X_RIVET_TOKEN, actor_path::ParsedActorPath,
};
use crate::{
	errors, metrics,
	routing::{
		actor_path::{is_actor_gateway_path, parse_actor_path},
		pegboard_gateway::resolve_actor_query::ResolveQueryActorResult,
	},
	shared_state::SharedState,
};
use cors::{CorsPreflight, set_non_preflight_cors};
use resolve_actor_query::resolve_query;

/// Time to wait before starting pool error checks
const RUNNER_POOL_ERROR_CHECK_DELAY: Duration = Duration::from_secs(1);
/// Interval between pool error checks
const RUNNER_POOL_ERROR_CHECK_INTERVAL: Duration = Duration::from_secs(2);

pub const X_RIVET_ACTOR: HeaderName = HeaderName::from_static("x-rivet-actor");

/// Route requests to actor services using path-based routing
#[tracing::instrument(skip_all)]
pub async fn route_request_path_based(
	ctx: &StandaloneCtx,
	shared_state: &SharedState,
	req_ctx: &mut RequestContext,
) -> Result<Option<RoutingOutput>> {
	let res = route_request_path_based_inner(ctx, shared_state, req_ctx).await;

	match &res {
		Ok(Some(_)) | Err(_) => {
			// Attach CORS headers to the actual (non-OPTIONS) response so both the
			// actor response and any early error are readable by the browser.
			set_non_preflight_cors(req_ctx);
		}
		_ => {}
	}

	res
}

pub async fn route_request_path_based_inner(
	ctx: &StandaloneCtx,
	shared_state: &SharedState,
	req_ctx: &mut RequestContext,
) -> Result<Option<RoutingOutput>> {
	if req_ctx.method() == hyper::Method::OPTIONS {
		if is_actor_gateway_path(req_ctx.path()) {
			return Ok(Some(RoutingOutput::CustomServe(Arc::new(CorsPreflight))));
		}

		return Ok(None);
	}

	let Some(actor_path) = parse_actor_path(req_ctx.path())? else {
		return Ok(None);
	};

	tracing::debug!(?actor_path, "routing using path-based actor routing");

	let (actor_id, token, stripped_path, skip_ready_wait) = match actor_path {
		ParsedActorPath::Direct(path) => (
			Id::parse(&path.actor_id).context("invalid actor id in path")?,
			read_gateway_token_for_path_based(req_ctx, path.token.as_deref())?
				.map(ToOwned::to_owned),
			path.stripped_path.clone(),
			read_skip_ready_wait_for_path_based(req_ctx)?,
		),
		ParsedActorPath::Query(path) => match resolve_query(ctx, &path.query).await? {
			ResolveQueryActorResult::Found { actor_id } => (
				actor_id,
				read_gateway_token_for_path_based(req_ctx, path.token.as_deref())?
					.map(ToOwned::to_owned),
				path.stripped_path.clone(),
				path.query.skip_ready_wait(),
			),
			ResolveQueryActorResult::Forward { dc_label } => {
				let peer_dc = ctx
					.config()
					.dc_for_label(dc_label)
					.ok_or_else(|| rivet_api_util::errors::Datacenter::NotFound.build())?;

				return Ok(Some(RoutingOutput::Route(RouteConfig {
					targets: vec![RouteTarget {
						host: peer_dc
							.proxy_url_host()
							.context("bad peer dc proxy url host")?
							.to_string(),
						port: peer_dc
							.proxy_url_port()
							.context("bad peer dc proxy url port")?,
						path: req_ctx.path().to_owned(),
					}],
				})));
			}
		},
	};

	route_request_inner(
		ctx,
		shared_state,
		req_ctx,
		actor_id,
		&stripped_path,
		token.as_deref(),
		skip_ready_wait,
	)
	.await
	.map(Some)
}

/// Route requests to actor services based on headers
#[tracing::instrument(skip_all)]
pub async fn route_request(
	ctx: &StandaloneCtx,
	shared_state: &SharedState,
	req_ctx: &mut RequestContext,
	target: &str,
) -> Result<Option<RoutingOutput>> {
	// Check target
	if target != "actor" {
		return Ok(None);
	}

	if req_ctx.method() == hyper::Method::OPTIONS {
		return Ok(Some(RoutingOutput::CustomServe(Arc::new(CorsPreflight))));
	}

	if !req_ctx.is_websocket() && !is_actor_http_request_path(req_ctx.path()) {
		return Ok(None);
	}

	// Attach CORS headers to the actual (non-OPTIONS) response so both the
	// actor response and any early error are readable by the browser.
	set_non_preflight_cors(req_ctx);

	// Extract actor ID and token from WebSocket protocol or HTTP headers
	let (actor_id_str, token, skip_ready_wait) = if req_ctx.is_websocket() {
		// For WebSocket, parse the sec-websocket-protocol header
		let protocols_header = req_ctx
			.headers()
			.get(SEC_WEBSOCKET_PROTOCOL)
			.and_then(|protocols| protocols.to_str().ok())
			.ok_or_else(|| {
				crate::errors::MissingHeader {
					header: "sec-websocket-protocol".to_string(),
				}
				.build()
			})?;

		let protocols: Vec<&str> = protocols_header.split(',').map(|p| p.trim()).collect();

		let actor_id_raw = protocols
			.iter()
			.find_map(|p| p.strip_prefix(WS_PROTOCOL_ACTOR))
			.ok_or_else(|| {
				crate::errors::MissingHeader {
					header: "`rivet_actor.*` protocol in sec-websocket-protocol".to_string(),
				}
				.build()
			})?;

		let actor_id = urlencoding::decode(actor_id_raw)
			.context("invalid url encoding in actor id")?
			.to_string();

		let token = protocols
			.iter()
			.find_map(|p| p.strip_prefix(WS_PROTOCOL_TOKEN))
			.map(ToOwned::to_owned);

		let skip_ready_wait = protocols.iter().any(|p| p == &WS_PROTOCOL_SKIP_READY_WAIT);

		(actor_id, token, skip_ready_wait)
	} else {
		// For HTTP, use headers
		let actor_id = req_ctx
			.headers()
			.get(X_RIVET_ACTOR)
			.map(|x| x.to_str())
			.transpose()
			.context("invalid x-rivet-actor header")?
			.ok_or_else(|| {
				crate::errors::MissingHeader {
					header: X_RIVET_ACTOR.to_string(),
				}
				.build()
			})?;

		let token = req_ctx
			.headers()
			.get(X_RIVET_TOKEN)
			.map(|x| x.to_str())
			.transpose()
			.context("invalid x-rivet-token header")?
			.map(ToOwned::to_owned);

		let skip_ready_wait = read_skip_ready_wait_header(req_ctx)?;

		(actor_id.to_string(), token, skip_ready_wait)
	};

	// Find actor to route to
	let actor_id = Id::parse(&actor_id_str).context("invalid x-rivet-actor header")?;
	let stripped_path = req_ctx.path().to_owned();

	route_request_inner(
		ctx,
		shared_state,
		req_ctx,
		actor_id,
		&stripped_path,
		token.as_deref(),
		skip_ready_wait,
	)
	.await
	.map(Some)
}

fn is_actor_http_request_path(path: &str) -> bool {
	let Some(stripped) = path.strip_prefix("/request") else {
		return false;
	};

	stripped.is_empty() || matches!(stripped.as_bytes().first(), Some(b'/') | Some(b'?'))
}

async fn route_request_inner(
	ctx: &StandaloneCtx,
	shared_state: &SharedState,
	req_ctx: &mut RequestContext,
	actor_id: Id,
	stripped_path: &str,
	_token: Option<&str>,
	skip_ready_wait: bool,
) -> Result<RoutingOutput> {
	// NOTE: Token validation implemented in EE

	// Route to peer dc where the actor lives
	if actor_id.label() != ctx.config().dc_label() {
		tracing::debug!(peer_dc_label=?actor_id.label(), "re-routing actor to peer dc");

		let peer_dc = ctx
			.config()
			.dc_for_label(actor_id.label())
			.ok_or_else(|| rivet_api_util::errors::Datacenter::NotFound.build())?;

		return Ok(RoutingOutput::Route(RouteConfig {
			targets: vec![RouteTarget {
				host: peer_dc
					.proxy_url_host()
					.context("bad peer dc proxy url host")?
					.to_string(),
				port: peer_dc
					.proxy_url_port()
					.context("bad peer dc proxy url port")?,
				path: req_ctx.path().to_owned(),
			}],
		}));
	}

	if let Some(route) = lookup_ready_directory_route_for_request(
		&shared_state.routing_directory,
		actor_id,
		Instant::now(),
		routing_directory_stale_after(ctx),
		req_ctx.is_route_refresh(),
	) {
		tracing::debug!(?actor_id, route = ?route, "routing actor from directory");
		return route.into_routing_output(ctx, shared_state, actor_id, stripped_path);
	}

	// Create subs before checking if actor exists/is not destroyed
	let (
		ready_sub,
		stopped_sub,
		fail_sub,
		destroy_sub,
		migrate_sub,
		ready_sub2,
		stopped_sub2,
		fail_sub2,
		destroy_sub2,
	) = tokio::try_join!(
		ctx.subscribe::<pegboard::workflows::actor::Ready>(("actor_id", actor_id)),
		ctx.subscribe::<pegboard::workflows::actor::Stopped>(("actor_id", actor_id)),
		ctx.subscribe::<pegboard::workflows::actor::Failed>(("actor_id", actor_id)),
		ctx.subscribe::<pegboard::workflows::actor::DestroyStarted>(("actor_id", actor_id)),
		ctx.subscribe::<pegboard::workflows::actor::MigratedToV2>(("actor_id", actor_id)),
		ctx.subscribe::<pegboard::workflows::actor2::Ready>(("actor_id", actor_id)),
		ctx.subscribe::<pegboard::workflows::actor2::Stopped>(("actor_id", actor_id)),
		ctx.subscribe::<pegboard::workflows::actor2::Failed>(("actor_id", actor_id)),
		ctx.subscribe::<pegboard::workflows::actor2::DestroyStarted>(("actor_id", actor_id)),
	)?;

	// Fetch actor info
	let Some(actor) = ctx
		.op(pegboard::ops::actor::get_for_gateway::Input { actor_id })
		.await?
	else {
		return Err(pegboard::errors::Actor::NotFound.build());
	};

	if actor.destroyed {
		return Err(pegboard::errors::Actor::NotFound.build());
	}

	seed_routing_directory_from_storage_actor(&shared_state.routing_directory, actor_id, &actor);

	match actor.version {
		2 => {
			drop(ready_sub);
			drop(stopped_sub);
			drop(fail_sub);
			drop(destroy_sub);
			drop(migrate_sub);

			handle_actor_v2(
				ctx,
				shared_state,
				actor_id,
				actor,
				stripped_path,
				skip_ready_wait,
				ready_sub2,
				stopped_sub2,
				fail_sub2,
				destroy_sub2,
			)
			.await
		}
		1 => {
			handle_actor_v1(
				ctx,
				shared_state,
				actor_id,
				actor,
				stripped_path,
				skip_ready_wait,
				ready_sub,
				stopped_sub,
				fail_sub,
				destroy_sub,
				migrate_sub,
				ready_sub2,
				stopped_sub2,
				fail_sub2,
				destroy_sub2,
			)
			.await
		}
		_ => bail!("unknown actor version"),
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum DirectoryRoute {
	Runner { runner_id: Id },
	Envoy { namespace_id: Id, envoy_key: String },
}

impl DirectoryRoute {
	fn target_label(&self) -> &'static str {
		match self {
			DirectoryRoute::Runner { .. } => "runner",
			DirectoryRoute::Envoy { .. } => "envoy",
		}
	}

	fn into_routing_output(
		self,
		ctx: &StandaloneCtx,
		shared_state: &SharedState,
		actor_id: Id,
		stripped_path: &str,
	) -> Result<RoutingOutput> {
		match self {
			DirectoryRoute::Runner { runner_id } => {
				let gateway = pegboard_gateway::PegboardGateway::new(
					ctx.clone(),
					shared_state.pegboard_gateway.clone(),
					runner_id,
					actor_id,
					stripped_path.to_string(),
				);
				Ok(RoutingOutput::CustomServe(Arc::new(gateway)))
			}
			DirectoryRoute::Envoy {
				namespace_id,
				envoy_key,
			} => {
				let gateway = pegboard_gateway2::PegboardGateway2::new(
					ctx.clone(),
					shared_state.pegboard_gateway2.clone(),
					namespace_id,
					envoy_key,
					actor_id,
					stripped_path.to_string(),
				);
				Ok(RoutingOutput::CustomServe(Arc::new(gateway)))
			}
		}
	}
}

fn lookup_ready_directory_route(
	directory: &RoutingDirectory,
	actor_id: Id,
	now: Instant,
	stale_after: Duration,
) -> Option<DirectoryRoute> {
	match directory.lookup(actor_id, now, stale_after) {
		RoutingLookup::Ready(snapshot) => {
			let route = directory_route_from_snapshot(snapshot);
			if let Some(route) = &route {
				record_routing_directory_lookup("ready", route.target_label());
			} else {
				record_routing_directory_lookup("malformed", "none");
			}
			route
		}
		RoutingLookup::NotReady(snapshot) => {
			record_routing_directory_lookup(
				"not_ready",
				routing_target_label(snapshot.target.as_ref()),
			);
			tracing::debug!(
				?actor_id,
				status = ?snapshot.status,
				generation = snapshot.generation,
				"actor routing directory entry is not ready"
			);
			None
		}
		RoutingLookup::Stale(snapshot) => {
			record_routing_directory_lookup(
				"stale",
				routing_target_label(snapshot.target.as_ref()),
			);
			tracing::debug!(
				?actor_id,
				status = ?snapshot.status,
				generation = snapshot.generation,
				"actor routing directory entry is stale"
			);
			None
		}
		RoutingLookup::Missing => {
			record_routing_directory_lookup("missing", "none");
			None
		}
	}
}

fn lookup_ready_directory_route_for_request(
	directory: &RoutingDirectory,
	actor_id: Id,
	now: Instant,
	stale_after: Duration,
	route_refresh: bool,
) -> Option<DirectoryRoute> {
	if route_refresh {
		record_routing_directory_lookup("route_refresh", "none");
		if directory.mark_stale_at(actor_id, now) {
			tracing::debug!(
				?actor_id,
				"staled actor routing directory entry before route refresh"
			);
		}

		return None;
	}

	lookup_ready_directory_route(directory, actor_id, now, stale_after)
}

fn record_routing_directory_lookup(result: &'static str, target: &'static str) {
	metrics::ROUTING_DIRECTORY_LOOKUP_TOTAL
		.with_label_values(&[result, target])
		.inc();
}

fn routing_target_label(target: Option<&RoutingTarget>) -> &'static str {
	match target {
		Some(RoutingTarget::Runner { .. }) => "runner",
		Some(RoutingTarget::Envoy { .. }) => "envoy",
		None => "none",
	}
}

fn directory_route_from_snapshot(snapshot: RoutingSnapshot) -> Option<DirectoryRoute> {
	match snapshot.target? {
		RoutingTarget::Runner { runner_id } => Some(DirectoryRoute::Runner { runner_id }),
		RoutingTarget::Envoy {
			namespace_id,
			envoy_key,
		} => Some(DirectoryRoute::Envoy {
			namespace_id,
			envoy_key,
		}),
	}
}

fn routing_directory_stale_after(ctx: &StandaloneCtx) -> Duration {
	let pegboard = ctx.config().pegboard();
	let runner_ms = u64::try_from(pegboard.runner_eligible_threshold()).unwrap_or_default();
	let envoy_ms = u64::try_from(pegboard.envoy_eligible_threshold()).unwrap_or_default();
	Duration::from_millis(runner_ms.min(envoy_ms))
}

fn seed_routing_directory_from_storage_actor(
	directory: &RoutingDirectory,
	actor_id: Id,
	actor: &pegboard::ops::actor::get_for_gateway::Output,
) -> bool {
	let Some(delta) = routing_delta_from_storage_actor(actor_id, actor) else {
		return false;
	};

	let applied = directory.apply_delta(delta);
	if !applied {
		tracing::debug!(
			?actor_id,
			"ignored stale storage actor while seeding routing directory"
		);
	}
	applied
}

fn routing_delta_from_storage_actor(
	actor_id: Id,
	actor: &pegboard::ops::actor::get_for_gateway::Output,
) -> Option<RoutingDelta> {
	if !actor.connectable {
		return None;
	}

	let generation = u64::from(actor.routing_generation?);
	match actor.version {
		1 => actor.runner_id.map(|runner_id| RoutingDelta::Ready {
			actor_id,
			generation,
			target: RoutingTarget::Runner { runner_id },
		}),
		2 => actor
			.envoy_key
			.as_ref()
			.map(|envoy_key| RoutingDelta::Ready {
				actor_id,
				generation,
				target: RoutingTarget::Envoy {
					namespace_id: actor.namespace_id,
					envoy_key: envoy_key.clone(),
				},
			}),
		_ => None,
	}
}

async fn handle_actor_v2(
	ctx: &StandaloneCtx,
	shared_state: &SharedState,
	actor_id: Id,
	actor: pegboard::ops::actor::get_for_gateway::Output,
	stripped_path: &str,
	skip_ready_wait: bool,
	mut ready_sub: SubscriptionHandle<pegboard::workflows::actor2::Ready>,
	mut stopped_sub: SubscriptionHandle<pegboard::workflows::actor2::Stopped>,
	mut fail_sub: SubscriptionHandle<pegboard::workflows::actor2::Failed>,
	mut destroy_sub: SubscriptionHandle<pegboard::workflows::actor2::DestroyStarted>,
) -> Result<RoutingOutput> {
	// Wake actor if sleeping
	if actor.sleeping {
		tracing::debug!(?actor_id, "actor sleeping, waking");

		ctx.signal(pegboard::workflows::actor2::Wake {})
			.to_workflow_id(actor.workflow_id)
			.send()
			.await?;
	}

	let envoy_key = if let (Some(envoy_key), true) =
		(actor.envoy_key, actor.connectable || skip_ready_wait)
	{
		envoy_key
	} else {
		tracing::debug!(?actor_id, "waiting for actor to become ready");
		let stale_after = routing_directory_stale_after(ctx);
		let mut routing_updates = shared_state.routing_directory_updates.subscribe();

		if let Some(envoy_key) = lookup_ready_envoy_key_from_directory(
			&shared_state.routing_directory,
			actor_id,
			stale_after,
		) {
			envoy_key
		} else {
			let mut wake_retries = 0;

			// Create pool error check future
			let pool_error_check_fut = check_runner_pool_error_loop(
				ctx,
				actor.namespace_id,
				actor.runner_name_selector.as_deref(),
			);
			tokio::pin!(pool_error_check_fut);

			// Wait for ready, fail, destroy, or a fresh routing-directory delta.
			loop {
				let routing_update_fut = wait_for_routing_directory_update(&mut routing_updates);
				tokio::pin!(routing_update_fut);

				if let Some(envoy_key) = lookup_ready_envoy_key_from_directory(
					&shared_state.routing_directory,
					actor_id,
					stale_after,
				) {
					break envoy_key;
				}

				tokio::select! {
					res = ready_sub.next() => break res?.into_body().envoy_key,
					_ = &mut routing_update_fut => {}
					res = stopped_sub.next() => {
						res?;

						if wake_retries < 8 {
							tracing::debug!(?actor_id, ?wake_retries, "actor stopped while we were waiting for it to become ready, attempting rewake");
							wake_retries += 1;

							let res = ctx.signal(pegboard::workflows::actor2::Wake {})
							.to_workflow_id(actor.workflow_id)
							.graceful_not_found()
							.send()
							.await?;

							if res.is_none() {
								tracing::warn!(
									?actor_id,
									"actor workflow not found for rewake"
								);
								return Err(pegboard::errors::Actor::NotFound.build());
							}
						} else {
							tracing::warn!("actor retried waking 8 times, has not yet started");
							return Err(rivet_guard_core::errors::ServiceUnavailable.build());
						}
					}
					res = fail_sub.next() => {
						let msg = res?;
						return Err(msg.error.clone().build());
					}
					res = destroy_sub.next() => {
						res?;
						return Err(pegboard::errors::Actor::DestroyedWhileWaitingForReady.build());
					}
					res = &mut pool_error_check_fut => {
						if res? {
							return Err(errors::ActorRunnerFailed { actor_id }.build());
						}
					}
					// Ready timeout
					_ = tokio::time::sleep(ctx.config().guard().actor_ready_timeout()) => {
						return Err(errors::ActorReadyTimeout { actor_id }.build());
					}
				}
			}
		}
	};

	tracing::debug!(?actor_id, %envoy_key, "actor ready");

	// Return pegboard-gateway2 instance with path
	let gateway = pegboard_gateway2::PegboardGateway2::new(
		ctx.clone(),
		shared_state.pegboard_gateway2.clone(),
		actor.namespace_id,
		envoy_key,
		actor_id,
		stripped_path.to_string(),
	);
	Ok(RoutingOutput::CustomServe(std::sync::Arc::new(gateway)))
}

async fn handle_actor_v1(
	ctx: &StandaloneCtx,
	shared_state: &SharedState,
	actor_id: Id,
	actor: pegboard::ops::actor::get_for_gateway::Output,
	stripped_path: &str,
	skip_ready_wait: bool,
	mut ready_sub: SubscriptionHandle<pegboard::workflows::actor::Ready>,
	mut stopped_sub: SubscriptionHandle<pegboard::workflows::actor::Stopped>,
	mut fail_sub: SubscriptionHandle<pegboard::workflows::actor::Failed>,
	mut destroy_sub: SubscriptionHandle<pegboard::workflows::actor::DestroyStarted>,
	mut migrate_sub: SubscriptionHandle<pegboard::workflows::actor::MigratedToV2>,
	ready_sub2: SubscriptionHandle<pegboard::workflows::actor2::Ready>,
	stopped_sub2: SubscriptionHandle<pegboard::workflows::actor2::Stopped>,
	fail_sub2: SubscriptionHandle<pegboard::workflows::actor2::Failed>,
	destroy_sub2: SubscriptionHandle<pegboard::workflows::actor2::DestroyStarted>,
) -> Result<RoutingOutput> {
	// Wake actor if sleeping
	if actor.sleeping {
		tracing::debug!(?actor_id, "actor sleeping, waking");

		ctx.signal(pegboard::workflows::actor::Wake {
			allocation_override: pegboard::workflows::actor::AllocationOverride::DontSleep {
				pending_timeout: Some(ctx.config().guard().actor_force_wake_pending_timeout()),
			},
		})
		.to_workflow_id(actor.workflow_id)
		.send()
		.await?;
	}

	let runner_id = if let (Some(runner_id), true) =
		(actor.runner_id, actor.connectable || skip_ready_wait)
	{
		runner_id
	} else {
		tracing::debug!(?actor_id, "waiting for actor to become ready");
		let stale_after = routing_directory_stale_after(ctx);
		let mut routing_updates = shared_state.routing_directory_updates.subscribe();

		if let Some(runner_id) = lookup_ready_runner_from_directory(
			&shared_state.routing_directory,
			actor_id,
			stale_after,
		) {
			runner_id
		} else {
			let mut wake_retries = 0;

			// Create pool error check future
			let runner_name_selector = actor.runner_name_selector.clone();
			let pool_error_check_fut = check_runner_pool_error_loop(
				ctx,
				actor.namespace_id,
				runner_name_selector.as_deref(),
			);
			tokio::pin!(pool_error_check_fut);

			// Wait for ready, fail, destroy, migration, or a fresh routing-directory delta.
			loop {
				let routing_update_fut = wait_for_routing_directory_update(&mut routing_updates);
				tokio::pin!(routing_update_fut);

				if let Some(runner_id) = lookup_ready_runner_from_directory(
					&shared_state.routing_directory,
					actor_id,
					stale_after,
				) {
					break runner_id;
				}

				tokio::select! {
					res = ready_sub.next() => break res?.runner_id,
					_ = &mut routing_update_fut => {}
					res = stopped_sub.next() => {
						res?;

						if wake_retries < 8 {
							tracing::debug!(?actor_id, ?wake_retries, "actor stopped while we were waiting for it to become ready, attempting rewake");
							wake_retries += 1;

							let res = ctx.signal(pegboard::workflows::actor::Wake {
								allocation_override: pegboard::workflows::actor::AllocationOverride::DontSleep {
									pending_timeout: Some(
										ctx.config().guard().actor_force_wake_pending_timeout(),
									),
								},
							})
							.to_workflow_id(actor.workflow_id)
							.graceful_not_found()
							.send()
							.await?;

							if res.is_none() {
								tracing::warn!(
									?actor_id,
									"actor workflow not found for rewake"
								);
								return Err(pegboard::errors::Actor::NotFound.build());
							}
						} else {
							tracing::warn!("actor retried waking 8 times, has not yet started");
							return Err(rivet_guard_core::errors::ServiceUnavailable.build());
						}
					}
					res = fail_sub.next() => {
						let msg = res?;
						return Err(msg.error.clone().build());
					}
					res = destroy_sub.next() => {
						res?;
						return Err(pegboard::errors::Actor::DestroyedWhileWaitingForReady.build());
					}
					res = migrate_sub.next() => {
						res?;
						return handle_actor_v2(
							ctx,
							shared_state,
							actor_id,
							actor,
							stripped_path,
							skip_ready_wait,
							ready_sub2,
							stopped_sub2,
							fail_sub2,
							destroy_sub2,
						).await;
					}
					res = &mut pool_error_check_fut => {
						if res? {
							return Err(errors::ActorRunnerFailed { actor_id }.build());
						}
					}
					// Ready timeout
					_ = tokio::time::sleep(ctx.config().guard().actor_ready_timeout()) => {
						return Err(errors::ActorReadyTimeout { actor_id }.build());
					}
				}
			}
		}
	};

	tracing::debug!(?actor_id, ?runner_id, "actor ready");

	// Return pegboard-gateway instance with path
	let gateway = pegboard_gateway::PegboardGateway::new(
		ctx.clone(),
		shared_state.pegboard_gateway.clone(),
		runner_id,
		actor_id,
		stripped_path.to_string(),
	);
	Ok(RoutingOutput::CustomServe(std::sync::Arc::new(gateway)))
}

async fn wait_for_routing_directory_update(updates: &mut watch::Receiver<u64>) {
	if updates.changed().await.is_err() {
		std::future::pending::<()>().await;
	}
}

fn lookup_ready_runner_from_directory(
	directory: &RoutingDirectory,
	actor_id: Id,
	stale_after: Duration,
) -> Option<Id> {
	match lookup_ready_directory_route(directory, actor_id, Instant::now(), stale_after) {
		Some(DirectoryRoute::Runner { runner_id }) => Some(runner_id),
		Some(route) => {
			tracing::debug!(?actor_id, route=?route, "ignoring non-runner directory route while waiting for v1 actor");
			None
		}
		None => None,
	}
}

fn lookup_ready_envoy_key_from_directory(
	directory: &RoutingDirectory,
	actor_id: Id,
	stale_after: Duration,
) -> Option<String> {
	match lookup_ready_directory_route(directory, actor_id, Instant::now(), stale_after) {
		Some(DirectoryRoute::Envoy { envoy_key, .. }) => Some(envoy_key),
		Some(route) => {
			tracing::debug!(?actor_id, route=?route, "ignoring non-envoy directory route while waiting for v2 actor");
			None
		}
		None => None,
	}
}

fn read_gateway_token_for_path_based<'a>(
	req_ctx: &'a RequestContext,
	token_from_path: Option<&'a str>,
) -> Result<Option<&'a str>> {
	if let Some(token) = token_from_path {
		return Ok(Some(token));
	}

	if req_ctx.is_websocket() {
		let protocols_header = req_ctx
			.headers()
			.get(SEC_WEBSOCKET_PROTOCOL)
			.and_then(|protocols| protocols.to_str().ok())
			.ok_or_else(|| {
				crate::errors::MissingHeader {
					header: "sec-websocket-protocol".to_string(),
				}
				.build()
			})?;

		let protocols = protocols_header
			.split(',')
			.map(|p| p.trim())
			.collect::<Vec<&str>>();

		Ok(protocols
			.iter()
			.find_map(|p| p.strip_prefix(WS_PROTOCOL_TOKEN)))
	} else {
		req_ctx
			.headers()
			.get(X_RIVET_TOKEN)
			.map(|x| x.to_str())
			.transpose()
			.context("invalid x-rivet-token header")
	}
}

fn read_skip_ready_wait_for_path_based(req_ctx: &RequestContext) -> Result<bool> {
	if req_ctx.is_websocket() {
		Ok(req_ctx
			.headers()
			.get(SEC_WEBSOCKET_PROTOCOL)
			.and_then(|protocols| protocols.to_str().ok())
			.is_some_and(|protocols| {
				protocols
					.split(',')
					.map(|p| p.trim())
					.any(|p| p == WS_PROTOCOL_SKIP_READY_WAIT)
			}))
	} else {
		read_skip_ready_wait_header(req_ctx)
	}
}

fn read_skip_ready_wait_header(req_ctx: &RequestContext) -> Result<bool> {
	let Some(value) = req_ctx.headers().get(X_RIVET_SKIP_READY_WAIT) else {
		return Ok(false);
	};

	let value = value
		.to_str()
		.context("invalid x-rivet-skip-ready-wait header")?;
	parse_skip_ready_wait_bool(value).ok_or_else(|| {
		crate::errors::InvalidHeader {
			header: X_RIVET_SKIP_READY_WAIT.to_string(),
			detail: "expected true, false, 1, or 0".to_string(),
		}
		.build()
	})
}

fn parse_skip_ready_wait_bool(value: &str) -> Option<bool> {
	match value {
		"true" | "1" => Some(true),
		"false" | "0" => Some(false),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use pegboard::routing_directory::{RoutingDelta, RoutingStatus};

	use super::*;

	fn id(label: u16) -> Id {
		Id::new_v1(label)
	}

	fn storage_actor(
		namespace_id: Id,
		workflow_id: Id,
	) -> pegboard::ops::actor::get_for_gateway::Output {
		pegboard::ops::actor::get_for_gateway::Output {
			namespace_id,
			workflow_id,
			runner_name_selector: None,
			sleeping: false,
			destroyed: false,
			connectable: true,
			runner_id: None,
			envoy_key: None,
			routing_generation: None,
			version: 1,
		}
	}

	fn duration_p99(durations: &mut [Duration]) -> Duration {
		assert!(
			!durations.is_empty(),
			"duration sample set must not be empty"
		);
		durations.sort_unstable();
		let rank = ((durations.len() * 99) + 99) / 100;
		durations[rank.saturating_sub(1)]
	}

	#[test]
	fn fresh_envoy_directory_entry_routes_without_fallback() {
		let directory = RoutingDirectory::new();
		let actor_id = id(30);
		let namespace_id = id(31);
		let now = Instant::now();

		assert!(directory.apply_delta_at(
			RoutingDelta::Ready {
				actor_id,
				generation: 1,
				target: RoutingTarget::Envoy {
					namespace_id,
					envoy_key: "envoy-a".to_owned(),
				},
			},
			now,
		));

		assert_eq!(
			lookup_ready_directory_route(&directory, actor_id, now, Duration::from_secs(30)),
			Some(DirectoryRoute::Envoy {
				namespace_id,
				envoy_key: "envoy-a".to_owned(),
			})
		);
	}

	#[test]
	fn fresh_runner_directory_entry_routes_without_fallback() {
		let directory = RoutingDirectory::new();
		let actor_id = id(32);
		let runner_id = id(33);
		let now = Instant::now();

		assert!(directory.apply_delta_at(
			RoutingDelta::Ready {
				actor_id,
				generation: 1,
				target: RoutingTarget::Runner { runner_id },
			},
			now,
		));

		assert_eq!(
			lookup_ready_directory_route(&directory, actor_id, now, Duration::from_secs(30)),
			Some(DirectoryRoute::Runner { runner_id })
		);
	}

	#[test]
	fn stale_directory_entry_falls_back_to_storage_path() {
		let directory = RoutingDirectory::new();
		let actor_id = id(34);
		let now = Instant::now();

		assert!(directory.apply_delta_at(
			RoutingDelta::Ready {
				actor_id,
				generation: 1,
				target: RoutingTarget::Runner { runner_id: id(35) },
			},
			now,
		));

		assert_eq!(
			lookup_ready_directory_route(
				&directory,
				actor_id,
				now + Duration::from_secs(31),
				Duration::from_secs(30),
			),
			None
		);
	}

	#[test]
	fn target_heartbeat_keeps_directory_route_hot_until_heartbeat_expires() {
		let directory = RoutingDirectory::new();
		let actor_id = id(41);
		let runner_id = id(42);
		let target = RoutingTarget::Runner { runner_id };
		let now = Instant::now();

		assert!(directory.apply_delta_at(
			RoutingDelta::Ready {
				actor_id,
				generation: 1,
				target: target.clone(),
			},
			now,
		));
		assert!(directory.apply_delta_at(
			RoutingDelta::TargetHeartbeat { target },
			now + Duration::from_secs(25),
		));

		assert_eq!(
			lookup_ready_directory_route(
				&directory,
				actor_id,
				now + Duration::from_secs(31),
				Duration::from_secs(30),
			),
			Some(DirectoryRoute::Runner { runner_id })
		);
		assert_eq!(
			lookup_ready_directory_route(
				&directory,
				actor_id,
				now + Duration::from_secs(56),
				Duration::from_secs(30),
			),
			None
		);
	}

	#[test]
	fn hibernating_directory_entry_falls_back_to_storage_path() {
		let directory = RoutingDirectory::new();
		let actor_id = id(36);
		let now = Instant::now();

		assert!(directory.apply_delta_at(
			RoutingDelta::Hibernating {
				actor_id,
				generation: 1,
				target: Some(RoutingTarget::Runner { runner_id: id(37) }),
			},
			now,
		));

		assert_eq!(
			lookup_ready_directory_route(&directory, actor_id, now, Duration::from_secs(30)),
			None
		);
	}

	#[test]
	fn ready_snapshot_without_target_falls_back_to_storage_path() {
		let actor_id = id(38);

		assert_eq!(
			directory_route_from_snapshot(RoutingSnapshot {
				actor_id,
				generation: 1,
				status: RoutingStatus::Ready,
				target: None,
			}),
			None
		);
	}

	#[test]
	fn route_refresh_stales_directory_entry_and_forces_fallback() {
		let directory = RoutingDirectory::new();
		let actor_id = id(39);
		let runner_id = id(40);
		let now = Instant::now();

		assert!(directory.apply_delta_at(
			RoutingDelta::Ready {
				actor_id,
				generation: 1,
				target: RoutingTarget::Runner { runner_id },
			},
			now,
		));

		assert_eq!(
			lookup_ready_directory_route_for_request(
				&directory,
				actor_id,
				now + Duration::from_millis(1),
				Duration::from_secs(30),
				true,
			),
			None
		);
		assert_eq!(
			lookup_ready_directory_route(
				&directory,
				actor_id,
				now + Duration::from_millis(2),
				Duration::from_secs(30),
			),
			None
		);

		assert!(directory.apply_delta_at(
			RoutingDelta::Ready {
				actor_id,
				generation: 1,
				target: RoutingTarget::Runner { runner_id },
			},
			now + Duration::from_millis(3),
		));
		assert_eq!(
			lookup_ready_directory_route(
				&directory,
				actor_id,
				now + Duration::from_millis(4),
				Duration::from_secs(30),
			),
			Some(DirectoryRoute::Runner { runner_id })
		);
	}

	#[test]
	fn storage_ready_actor_seeds_directory_for_second_connect() {
		let directory = RoutingDirectory::new();
		let actor_id = id(46);
		let runner_id = id(47);
		let now = Instant::now();
		let mut actor = storage_actor(id(48), id(49));
		actor.runner_id = Some(runner_id);
		actor.routing_generation = Some(7);

		assert!(seed_routing_directory_from_storage_actor(
			&directory, actor_id, &actor,
		));
		assert_eq!(
			directory.lookup(actor_id, now, Duration::from_secs(30)),
			RoutingLookup::Ready(RoutingSnapshot {
				actor_id,
				generation: 7,
				status: RoutingStatus::Ready,
				target: Some(RoutingTarget::Runner { runner_id }),
			})
		);

		let ready =
			crate::metrics::ROUTING_DIRECTORY_LOOKUP_TOTAL.with_label_values(&["ready", "runner"]);
		let ready_before = ready.get();
		assert_eq!(
			lookup_ready_directory_route(&directory, actor_id, now, Duration::from_secs(30)),
			Some(DirectoryRoute::Runner { runner_id })
		);
		assert!(ready.get() >= ready_before + 1);
	}

	#[test]
	fn storage_actor_without_generation_does_not_seed_directory() {
		let directory = RoutingDirectory::new();
		let actor_id = id(50);
		let runner_id = id(51);
		let mut actor = storage_actor(id(52), id(53));
		actor.runner_id = Some(runner_id);

		assert!(!seed_routing_directory_from_storage_actor(
			&directory, actor_id, &actor,
		));
		assert_eq!(
			directory.lookup(actor_id, Instant::now(), Duration::from_secs(30)),
			RoutingLookup::Missing
		);
	}

	#[tokio::test]
	async fn routing_directory_update_watch_keeps_pre_wait_updates() {
		let (tx, mut rx) = watch::channel(0);

		tx.send_modify(|version| *version += 1);

		tokio::time::timeout(
			Duration::from_millis(5),
			wait_for_routing_directory_update(&mut rx),
		)
		.await
		.expect("routing directory update should not be lost before wait is armed");
	}

	#[test]
	fn hot_directory_connects_ignore_storage_latency_during_lifecycle_churn() {
		let directory = RoutingDirectory::with_shards(16);
		let now = Instant::now();
		let stale_after = Duration::from_secs(30);
		let storage_latency = Duration::from_millis(100);
		let hot_actor_count = 128usize;
		let connect_count = 256usize;
		let churn_count = 32usize;

		let mut hot_routes = Vec::with_capacity(hot_actor_count);
		for index in 0..hot_actor_count {
			let actor_id = id(1000 + index as u16);
			let runner_id = id(2000 + index as u16);
			assert!(directory.apply_delta_at(
				RoutingDelta::Ready {
					actor_id,
					generation: 1,
					target: RoutingTarget::Runner { runner_id },
				},
				now,
			));
			hot_routes.push((actor_id, runner_id));
		}

		let mut churn_routes = Vec::with_capacity(churn_count);
		for index in 0..churn_count {
			let actor_id = id(3000 + index as u16);
			let runner_id = id(4000 + index as u16);
			assert!(directory.apply_delta_at(
				RoutingDelta::Ready {
					actor_id,
					generation: 1,
					target: RoutingTarget::Runner { runner_id },
				},
				now,
			));
			churn_routes.push((actor_id, runner_id));
		}

		let ready =
			crate::metrics::ROUTING_DIRECTORY_LOOKUP_TOTAL.with_label_values(&["ready", "runner"]);
		let ready_before = ready.get();
		let mut storage_fallbacks = 0usize;
		let mut durations = Vec::with_capacity(connect_count);

		for index in 0..connect_count {
			let (churn_actor_id, churn_runner_id) = churn_routes[index % churn_count];
			let churn_generation = 2 + index as u64;
			let churn_target = RoutingTarget::Runner {
				runner_id: churn_runner_id,
			};
			let churn_delta = match index % 3 {
				0 => RoutingDelta::Hibernating {
					actor_id: churn_actor_id,
					generation: churn_generation,
					target: Some(churn_target),
				},
				1 => RoutingDelta::Ready {
					actor_id: churn_actor_id,
					generation: churn_generation,
					target: churn_target,
				},
				_ => RoutingDelta::Removed {
					actor_id: churn_actor_id,
					generation: churn_generation,
				},
			};
			assert!(
				directory.apply_delta_at(churn_delta, now + Duration::from_millis(index as u64),)
			);

			let (actor_id, _) = hot_routes[index % hot_actor_count];
			let started_at = Instant::now();
			if lookup_ready_directory_route(&directory, actor_id, Instant::now(), stale_after)
				.is_none()
			{
				storage_fallbacks += 1;
				std::thread::sleep(storage_latency);
			}
			durations.push(started_at.elapsed());
		}

		assert_eq!(storage_fallbacks, 0);
		assert!(ready.get() >= ready_before + connect_count as u64);
		assert!(
			duration_p99(&mut durations) < Duration::from_millis(50),
			"hot routing-directory connects should not inherit simulated storage latency"
		);
	}
}

/// Waits for initial delay, then periodically checks for runner pool errors.
///
/// Returns `true` if the pool has an active error, `false` otherwise.
///
/// This is used to short circuit waiting for the actor to schedule by checking if the underlying
/// pool is unhealthy. The initial delay is intended to give the actor time to allocate cleanly in
/// case the pool status is flapping.
async fn check_runner_pool_error_loop(
	ctx: &StandaloneCtx,
	namespace_id: Id,
	runner_name: Option<&str>,
) -> Result<bool> {
	// Skip pool error check for actors that have not backfilled yet
	let Some(runner_name) = runner_name else {
		std::future::pending::<()>().await;
		unreachable!()
	};

	tokio::time::sleep(RUNNER_POOL_ERROR_CHECK_DELAY).await;

	loop {
		let errors = ctx
			.op(pegboard::ops::runner_config::get_error::Input {
				runners: vec![(namespace_id, runner_name.to_string())],
			})
			.await?;

		if let Some(entry) = errors.into_iter().next() {
			tracing::warn!(
				%namespace_id,
				%runner_name,
				error = ?entry.error,
				"runner pool has active error, fast-failing request"
			);
			return Ok(true);
		}

		// Wait before next check
		tokio::time::sleep(RUNNER_POOL_ERROR_CHECK_INTERVAL).await;
	}
}
