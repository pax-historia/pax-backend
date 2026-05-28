use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use gas::prelude::*;
use rivet_api_util::{Method, request_remote_datacenter};
use rivet_types::actors::{Actor, CrashPolicy};

const SLOW_ACTOR_CREATE_HOP: Duration = Duration::from_millis(2000);
const SLOW_ACTOR_CREATE_TOTAL: Duration = Duration::from_millis(5000);

#[derive(Debug)]
pub struct Input {
	pub actor_id: Id,
	pub namespace_id: Id,
	pub name: String,
	pub key: Option<String>,
	pub runner_name_selector: String,
	pub lane_hint: Option<String>,
	pub crash_policy: CrashPolicy,
	pub input: Option<String>,
	/// If true, will handle ForwardToDatacenter errors by forwarding the request to the correct datacenter.
	/// Used by api-public. api-peer should set this to false.
	pub forward_request: bool,
	/// Datacenter to create the actor in
	///
	/// Providing this value will cause an error if attempting to create an actor where the key is
	/// reserved in a different datacenter.
	pub datacenter_name: Option<String>,
}

#[derive(Debug)]
pub struct Output {
	pub actor: Actor,
}

#[operation]
pub async fn pegboard_actor_create(ctx: &OperationCtx, input: &Input) -> Result<Output> {
	let total_started = Instant::now();

	// Set up subscriptions before dispatching workflow
	let hop_started = Instant::now();
	let (
		mut create_sub,
		mut fail_sub,
		mut destroy_sub,
		mut create_sub2,
		mut fail_sub2,
		mut destroy_sub2,
		pool_res,
	) = tokio::try_join!(
		ctx.subscribe::<crate::workflows::actor::CreateComplete>(("actor_id", input.actor_id)),
		ctx.subscribe::<crate::workflows::actor::Failed>(("actor_id", input.actor_id)),
		ctx.subscribe::<crate::workflows::actor::DestroyStarted>(("actor_id", input.actor_id)),
		ctx.subscribe::<crate::workflows::actor2::CreateComplete>(("actor_id", input.actor_id)),
		ctx.subscribe::<crate::workflows::actor2::Failed>(("actor_id", input.actor_id)),
		ctx.subscribe::<crate::workflows::actor2::DestroyStarted>(("actor_id", input.actor_id)),
		ctx.op(crate::ops::runner_config::get::Input {
			runners: vec![(input.namespace_id, input.runner_name_selector.clone())],
			bypass_cache: false,
		}),
	)?;
	log_slow_actor_create_hop(
		input.actor_id,
		"subscribe_and_pool_config",
		hop_started.elapsed(),
	);

	let actor_v2 = pool_res
		.into_iter()
		.next()
		.map(|p| p.protocol_version.is_some())
		.unwrap_or_default();
	let created_actor = if actor_v2 {
		// Dispatch actor workflow
		let hop_started = Instant::now();
		ctx.workflow(crate::workflows::actor2::Input {
			actor_id: input.actor_id,
			name: input.name.clone(),
			pool_name: input.runner_name_selector.clone(),
			key: input.key.clone(),
			lane_hint: input.lane_hint.clone(),
			namespace_id: input.namespace_id,
			input: input.input.clone(),
			from_v1: false,
		})
		.tag("actor_id", input.actor_id)
		.dispatch()
		.await?;
		log_slow_actor_create_hop(
			input.actor_id,
			"dispatch_workflow_v2",
			hop_started.elapsed(),
		);

		// Wait for actor creation to complete, fail, or be destroyed
		let hop_started = Instant::now();
		tokio::select! {
			res = create_sub2.next() => {
				let msg = res?;
				log_slow_actor_create_hop(
					input.actor_id,
					"wait_create_complete_v2",
					hop_started.elapsed(),
				);
				msg.into_body().actor
			},
			res = fail_sub2.next() => {
				let msg = res?;
				let error = msg.into_body().error;
				log_slow_actor_create_hop(
					input.actor_id,
					"wait_failed_v2",
					hop_started.elapsed(),
				);

				// Check if this request needs to be forwarded
				//
				// We cannot forward if `datacenter_name` is specified because this actor is being
				// restricted to the given datacenter.
				if input.forward_request && input.datacenter_name.is_none() {
					if let crate::errors::Actor::KeyReservedInDifferentDatacenter { datacenter_label } = &error {
						// Forward the request to the correct datacenter
						return forward_to_datacenter(
							ctx,
							*datacenter_label,
							input.namespace_id,
							input.name.clone(),
							input.key.clone(),
							input.runner_name_selector.clone(),
							input.lane_hint.clone(),
							input.input.clone(),
							input.crash_policy,
						)
						.await;
					}
				}

				// Otherwise, return the error as-is
				log_slow_actor_create_total(input.actor_id, "failed_v2", total_started.elapsed());
				return Err(error.build());
			}
			res = destroy_sub2.next() => {
				res?;
				log_slow_actor_create_hop(
					input.actor_id,
					"wait_destroyed_v2",
					hop_started.elapsed(),
				);
				log_slow_actor_create_total(input.actor_id, "destroyed_v2", total_started.elapsed());
				return Err(crate::errors::Actor::DestroyedDuringCreation.build());
			}
		}
	} else {
		// Dispatch actor workflow
		let hop_started = Instant::now();
		ctx.workflow(crate::workflows::actor::Input {
			actor_id: input.actor_id,
			name: input.name.clone(),
			runner_name_selector: input.runner_name_selector.clone(),
			lane_hint: input.lane_hint.clone(),
			key: input.key.clone(),
			namespace_id: input.namespace_id,
			crash_policy: input.crash_policy,
			input: input.input.clone(),
		})
		.tag("actor_id", input.actor_id)
		.dispatch()
		.await?;
		log_slow_actor_create_hop(
			input.actor_id,
			"dispatch_workflow_v1",
			hop_started.elapsed(),
		);

		// Wait for actor creation to complete, fail, or be destroyed
		let hop_started = Instant::now();
		tokio::select! {
			res = create_sub.next() => {
				let msg = res?;
				log_slow_actor_create_hop(
					input.actor_id,
					"wait_create_complete_v1",
					hop_started.elapsed(),
				);
				msg.into_body().actor
			},
			res = fail_sub.next() => {
				let msg = res?;
				let error = msg.into_body().error;
				log_slow_actor_create_hop(
					input.actor_id,
					"wait_failed_v1",
					hop_started.elapsed(),
				);

				// Check if this request needs to be forwarded
				//
				// We cannot forward if `datacenter_name` is specified because this actor is being
				// restricted to the given datacenter.
				if input.forward_request && input.datacenter_name.is_none() {
					if let crate::errors::Actor::KeyReservedInDifferentDatacenter { datacenter_label } = &error {
						// Forward the request to the correct datacenter
						return forward_to_datacenter(
							ctx,
							*datacenter_label,
							input.namespace_id,
							input.name.clone(),
							input.key.clone(),
							input.runner_name_selector.clone(),
							input.lane_hint.clone(),
							input.input.clone(),
							input.crash_policy,
						)
						.await;
					}
				}

				// Otherwise, return the error as-is
				log_slow_actor_create_total(input.actor_id, "failed_v1", total_started.elapsed());
				return Err(error.build());
			}
			res = destroy_sub.next() => {
				res?;
				log_slow_actor_create_hop(
					input.actor_id,
					"wait_destroyed_v1",
					hop_started.elapsed(),
				);
				log_slow_actor_create_total(input.actor_id, "destroyed_v1", total_started.elapsed());
				return Err(crate::errors::Actor::DestroyedDuringCreation.build());
			}
		}
	};

	if let Some(actor) = created_actor {
		log_slow_actor_create_total(input.actor_id, "created", total_started.elapsed());
		return Ok(Output { actor });
	}

	// Fetch the created actor
	let hop_started = Instant::now();
	let actors_res = ctx
		.op(crate::ops::actor::get::Input {
			actor_ids: vec![input.actor_id],
			fetch_error: false,
		})
		.await?;
	log_slow_actor_create_hop(input.actor_id, "fetch_created_actor", hop_started.elapsed());

	let actor = actors_res
		.actors
		.into_iter()
		.next()
		.ok_or_else(|| crate::errors::Actor::NotFound.build())?;

	log_slow_actor_create_total(input.actor_id, "created", total_started.elapsed());
	Ok(Output { actor })
}

fn log_slow_actor_create_hop(actor_id: Id, actor_create_hop: &'static str, duration: Duration) {
	if duration < SLOW_ACTOR_CREATE_HOP {
		return;
	}

	tracing::warn!(
		?actor_id,
		actor_create_hop,
		actor_create_hop_duration_ms = duration.as_millis(),
		"slow actor create op hop"
	);
}

fn log_slow_actor_create_total(
	actor_id: Id,
	actor_create_result: &'static str,
	duration: Duration,
) {
	if duration < SLOW_ACTOR_CREATE_TOTAL {
		return;
	}

	tracing::warn!(
		?actor_id,
		actor_create_result,
		actor_create_duration_ms = duration.as_millis(),
		"slow actor create op"
	);
}

/// Forward the actor creation request to the correct datacenter
async fn forward_to_datacenter(
	ctx: &OperationCtx,
	datacenter_label: u16,
	namespace_id: Id,
	name: String,
	key: Option<String>,
	runner_name_selector: String,
	lane_hint: Option<String>,
	input: Option<String>,
	crash_policy: CrashPolicy,
) -> Result<Output> {
	// Get the datacenter configuration
	let _target_dc = ctx
		.config()
		.dc_for_label(datacenter_label)
		.with_context(|| format!("datacenter not found for label {}", datacenter_label))?;

	// Get namespace name for the remote call
	let namespace = ctx
		.op(namespace::ops::get_global::Input {
			namespace_ids: vec![namespace_id],
		})
		.await?
		.into_iter()
		.next()
		.ok_or_else(|| namespace::errors::Namespace::NotFound.build())?;

	// Make request to remote datacenter
	let response = request_remote_datacenter::<rivet_api_types::actors::create::CreateResponse>(
		ctx.config(),
		datacenter_label,
		"/actors",
		Method::POST,
		Some(&rivet_api_types::actors::create::CreateQuery {
			namespace: namespace.name.clone(),
		}),
		Some(&rivet_api_types::actors::create::CreateRequest {
			datacenter: None,
			name,
			key,
			input,
			runner_name_selector,
			lane_hint,
			crash_policy,
		}),
	)
	.await?;

	Ok(Output {
		actor: response.actor,
	})
}
