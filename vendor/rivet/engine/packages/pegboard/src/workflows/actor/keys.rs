use std::sync::{
	Arc,
	atomic::{AtomicU64, AtomicUsize, Ordering},
};

use epoxy::{
	ops::propose::{
		CheckAndSetCommand, Command, CommandKind, ConsensusFailedReason, Proposal, ProposalResult,
	},
	protocol::ReplicaId,
};
use futures_util::TryStreamExt;
use gas::prelude::*;
use rivet_data::converted::ActorByKeyKeyData;
use universaldb::options::StreamingMode;
use universaldb::prelude::*;

use crate::keys;

use super::{log_slow_actor_setup_hop, log_slow_actor_setup_tx_hop, setup};

#[derive(Debug, Serialize, Deserialize)]
pub enum ReserveKeyOutput {
	Success,
	ForwardToDatacenter { dc_label: u16 },
	KeyExists { existing_actor_id: Id },
}

pub async fn reserve_key(
	ctx: &mut WorkflowCtx,
	namespace_id: Id,
	name: String,
	key: String,
	actor_id: Id,
	runner_name_selector: String,
) -> Result<ReserveKeyOutput> {
	let reserve_started = std::time::Instant::now();
	let hop_started = std::time::Instant::now();
	let create_ts = ctx.create_ts();
	let res = ctx
		.v(3)
		.activity(ReserveKeyFastInput {
			namespace_id,
			name,
			key,
			actor_id,
			runner_name_selector,
			create_ts,
		})
		.await?;
	log_slow_actor_setup_hop(actor_id, "reserve_key.fast_activity", hop_started.elapsed());
	log_slow_actor_setup_hop(actor_id, "reserve_key.total", reserve_started.elapsed());
	Ok(res)
}

pub async fn reserve_key_and_add_indexes(
	ctx: &mut WorkflowCtx,
	namespace_id: Id,
	name: String,
	key: String,
	actor_id: Id,
	runner_name_selector: String,
) -> Result<ReserveKeyOutput> {
	let reserve_started = std::time::Instant::now();
	let hop_started = std::time::Instant::now();
	let create_ts = ctx.create_ts();
	let res = ctx
		.v(4)
		.activity(ReserveKeyAndAddIndexesInput {
			namespace_id,
			name,
			key,
			actor_id,
			runner_name_selector,
			create_ts,
		})
		.await?;
	log_slow_actor_setup_hop(actor_id, "reserve_key.fast_activity", hop_started.elapsed());
	log_slow_actor_setup_hop(actor_id, "reserve_key.total", reserve_started.elapsed());
	Ok(res)
}

#[allow(dead_code)]
pub async fn reserve_key_legacy(
	ctx: &mut WorkflowCtx,
	namespace_id: Id,
	name: String,
	key: String,
	actor_id: Id,
	runner_name_selector: String,
) -> Result<ReserveKeyOutput> {
	let reserve_started = std::time::Instant::now();
	let hop_started = std::time::Instant::now();
	let optimistic_reservation_id = ctx
		.activity(LookupKeyOptimisticInput {
			namespace_id,
			name: name.clone(),
			key: key.clone(),
		})
		.await?;
	log_slow_actor_setup_hop(
		actor_id,
		"reserve_key.lookup_optimistic",
		hop_started.elapsed(),
	);

	let res = if let Some(reservation_id) = optimistic_reservation_id {
		// Key found optimistically

		handle_existing_reservation(ctx, reservation_id, namespace_id, name, key, actor_id).await
	} else {
		// Key not found optimistically

		let hop_started = std::time::Instant::now();
		let new_reservation_id = ctx.activity(GenerateReservationIdInput {}).await?;
		log_slow_actor_setup_hop(actor_id, "reserve_key.generate_id", hop_started.elapsed());

		let hop_started = std::time::Instant::now();
		let target_replicas = ctx
			.v(2)
			.activity(ResolveTargetReplicasInput {
				namespace_id,
				runner_name: runner_name_selector.clone(),
			})
			.await?;
		log_slow_actor_setup_hop(
			actor_id,
			"reserve_key.resolve_target_replicas",
			hop_started.elapsed(),
		);

		if !target_replicas.contains(&ctx.config().epoxy_replica_id())
			&& let Some(replica_id) = target_replicas.first()
		{
			let dc_label = u16::try_from(*replica_id)?;

			return Ok(ReserveKeyOutput::ForwardToDatacenter { dc_label });
		}

		let hop_started = std::time::Instant::now();
		let proposal_result = ctx
			.activity(ProposeInput {
				namespace_id,
				name: name.clone(),
				key: key.clone(),
				new_reservation_id,
				actor_id,
				target_replicas,
			})
			.await?;
		log_slow_actor_setup_hop(actor_id, "reserve_key.propose", hop_started.elapsed());

		match proposal_result {
			ProposalResult::Committed => {
				let hop_started = std::time::Instant::now();
				let output = ctx
					.activity(ReserveActorKeyInput {
						namespace_id,
						name: name.clone(),
						key: key.clone(),
						actor_id,
						create_ts: ctx.create_ts(),
					})
					.await?;
				log_slow_actor_setup_hop(
					actor_id,
					"reserve_key.write_actor_key",
					hop_started.elapsed(),
				);
				match output {
					ReserveActorKeyOutput::Success => Ok(ReserveKeyOutput::Success),
					ReserveActorKeyOutput::ExistingActor { existing_actor_id } => {
						Ok(ReserveKeyOutput::KeyExists { existing_actor_id })
					}
				}
			}
			ProposalResult::ConsensusFailed {
				reason: ConsensusFailedReason::ExpectedValueDoesNotMatch { current_value },
			} => {
				if let Some(current_value) = current_value {
					let existing_reservation_id = keys::epoxy::ns::ReservationByKeyKey::new(
						namespace_id,
						name.clone(),
						key.clone(),
					)
					.deserialize(&current_value)?;

					handle_existing_reservation(
						ctx,
						existing_reservation_id,
						namespace_id,
						name.clone(),
						key.clone(),
						actor_id,
					)
					.await
				} else {
					bail!("unreachable: current_value should exist")
				}
			}
			res => bail!("consensus failed: {res:?}"),
		}
	};
	log_slow_actor_setup_hop(actor_id, "reserve_key.total", reserve_started.elapsed());
	res
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct ReserveKeyFastInput {
	namespace_id: Id,
	name: String,
	key: String,
	actor_id: Id,
	runner_name_selector: String,
	create_ts: i64,
}

#[activity(ReserveKeyFast)]
pub async fn reserve_key_fast(
	ctx: &ActivityCtx,
	input: &ReserveKeyFastInput,
) -> Result<ReserveKeyOutput> {
	let hop_started = std::time::Instant::now();
	let target_replicas = ctx
		.op(
			crate::ops::runner::list_runner_config_epoxy_replica_ids::Input {
				namespace_id: input.namespace_id,
				runner_name: input.runner_name_selector.clone(),
			},
		)
		.await?
		.replicas;
	log_slow_actor_setup_hop(
		input.actor_id,
		"reserve_key.fast.resolve_target_replicas",
		hop_started.elapsed(),
	);

	if !target_replicas.contains(&ctx.config().epoxy_replica_id())
		&& let Some(replica_id) = target_replicas.first()
	{
		let dc_label = u16::try_from(*replica_id)?;
		return Ok(ReserveKeyOutput::ForwardToDatacenter { dc_label });
	}

	let reservation_key = keys::epoxy::ns::ReservationByKeyKey::new(
		input.namespace_id,
		input.name.clone(),
		input.key.clone(),
	);
	let local_replica_id = ctx.config().epoxy_replica_id();
	let is_local_single_replica =
		target_replicas.len() == 1 && target_replicas.first() == Some(&local_replica_id);
	if !is_local_single_replica {
		let hop_started = std::time::Instant::now();
		let optimistic_value = ctx
			.op(epoxy::ops::kv::get_optimistic::Input {
				replica_id: local_replica_id,
				key: keys::subspace().pack(&reservation_key),
				caching_behavior: epoxy::protocol::CachingBehavior::Optimistic,
				target_replicas: Some(target_replicas.clone()),
				save_empty: false,
			})
			.await?
			.value;
		log_slow_actor_setup_hop(
			input.actor_id,
			"reserve_key.fast.get_optimistic",
			hop_started.elapsed(),
		);

		if let Some(value) = optimistic_value {
			let reservation_id = reservation_key.deserialize(&value)?;
			let hop_started = std::time::Instant::now();
			return handle_existing_reservation_activity(
				ctx,
				reservation_id,
				input.namespace_id,
				&input.name,
				&input.key,
				input.actor_id,
				input.create_ts,
			)
			.await
			.inspect(|_| {
				log_slow_actor_setup_hop(
					input.actor_id,
					"reserve_key.fast.handle_existing",
					hop_started.elapsed(),
				);
			});
		}
	} else {
		tracing::debug!(
			actor_id = ?input.actor_id,
			namespace_id = ?input.namespace_id,
			runner_name = %input.runner_name_selector,
			"skipping actor key optimistic read for local single-replica reservation"
		);
	}

	let new_reservation_id = Id::new_v1(ctx.config().dc_label());
	let reservation_value = reservation_key.serialize(new_reservation_id)?;
	let hop_started = std::time::Instant::now();
	let proposal_result = ctx
		.op(epoxy::ops::propose::Input {
			proposal: Proposal {
				commands: vec![Command {
					kind: CommandKind::CheckAndSetCommand(CheckAndSetCommand {
						key: keys::subspace().pack(&reservation_key),
						expect_one_of: vec![None],
						new_value: Some(reservation_value),
					}),
				}],
			},
			mutable: false,
			purge_cache: false,
			target_replicas: Some(target_replicas),
		})
		.await?;
	log_slow_actor_setup_hop(
		input.actor_id,
		"reserve_key.fast.propose",
		hop_started.elapsed(),
	);

	match proposal_result {
		ProposalResult::Committed => {
			let hop_started = std::time::Instant::now();
			match write_new_actor_key_inner(
				ctx,
				input.namespace_id,
				&input.name,
				&input.key,
				input.actor_id,
				input.create_ts,
			)
			.await?
			{
				ReserveActorKeyOutput::Success => {
					log_slow_actor_setup_hop(
						input.actor_id,
						"reserve_key.fast.write_actor_key",
						hop_started.elapsed(),
					);
					Ok(ReserveKeyOutput::Success)
				}
				ReserveActorKeyOutput::ExistingActor { existing_actor_id } => {
					log_slow_actor_setup_hop(
						input.actor_id,
						"reserve_key.fast.write_actor_key",
						hop_started.elapsed(),
					);
					Ok(ReserveKeyOutput::KeyExists { existing_actor_id })
				}
			}
		}
		ProposalResult::ConsensusFailed {
			reason: ConsensusFailedReason::ExpectedValueDoesNotMatch { current_value },
		} => {
			if let Some(current_value) = current_value {
				let existing_reservation_id = reservation_key.deserialize(&current_value)?;
				let hop_started = std::time::Instant::now();
				handle_existing_reservation_activity(
					ctx,
					existing_reservation_id,
					input.namespace_id,
					&input.name,
					&input.key,
					input.actor_id,
					input.create_ts,
				)
				.await
				.inspect(|_| {
					log_slow_actor_setup_hop(
						input.actor_id,
						"reserve_key.fast.handle_existing",
						hop_started.elapsed(),
					);
				})
			} else {
				bail!("unreachable: current_value should exist")
			}
		}
		res => bail!("consensus failed: {res:?}"),
	}
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct ReserveKeyAndAddIndexesInput {
	namespace_id: Id,
	name: String,
	key: String,
	actor_id: Id,
	runner_name_selector: String,
	create_ts: i64,
}

#[activity(ReserveKeyAndAddIndexes)]
pub async fn reserve_key_and_add_indexes_activity(
	ctx: &ActivityCtx,
	input: &ReserveKeyAndAddIndexesInput,
) -> Result<ReserveKeyOutput> {
	reserve_key_and_add_indexes_with_create_ts(
		ctx,
		input.namespace_id,
		input.name.clone(),
		input.key.clone(),
		input.actor_id,
		input.runner_name_selector.clone(),
		input.create_ts,
	)
	.await
}

pub(super) async fn reserve_key_and_add_indexes_with_create_ts(
	ctx: &ActivityCtx,
	namespace_id: Id,
	name: String,
	key: String,
	actor_id: Id,
	runner_name_selector: String,
	create_ts: i64,
) -> Result<ReserveKeyOutput> {
	let hop_started = std::time::Instant::now();
	let target_replicas = ctx
		.op(
			crate::ops::runner::list_runner_config_epoxy_replica_ids::Input {
				namespace_id,
				runner_name: runner_name_selector.clone(),
			},
		)
		.await?
		.replicas;
	log_slow_actor_setup_hop(
		actor_id,
		"reserve_key.fast.resolve_target_replicas",
		hop_started.elapsed(),
	);

	if !target_replicas.contains(&ctx.config().epoxy_replica_id())
		&& let Some(replica_id) = target_replicas.first()
	{
		let dc_label = u16::try_from(*replica_id)?;
		return Ok(ReserveKeyOutput::ForwardToDatacenter { dc_label });
	}

	let reservation_key =
		keys::epoxy::ns::ReservationByKeyKey::new(namespace_id, name.clone(), key.clone());
	let local_replica_id = ctx.config().epoxy_replica_id();
	let is_local_single_replica =
		target_replicas.len() == 1 && target_replicas.first() == Some(&local_replica_id);
	if !is_local_single_replica {
		let hop_started = std::time::Instant::now();
		let optimistic_value = ctx
			.op(epoxy::ops::kv::get_optimistic::Input {
				replica_id: local_replica_id,
				key: keys::subspace().pack(&reservation_key),
				caching_behavior: epoxy::protocol::CachingBehavior::Optimistic,
				target_replicas: Some(target_replicas.clone()),
				save_empty: false,
			})
			.await?
			.value;
		log_slow_actor_setup_hop(
			actor_id,
			"reserve_key.fast.get_optimistic",
			hop_started.elapsed(),
		);

		if let Some(value) = optimistic_value {
			let reservation_id = reservation_key.deserialize(&value)?;
			let hop_started = std::time::Instant::now();
			return handle_existing_reservation_and_add_indexes_activity(
				ctx,
				reservation_id,
				namespace_id,
				&name,
				&key,
				actor_id,
				create_ts,
			)
			.await
			.inspect(|_| {
				log_slow_actor_setup_hop(
					actor_id,
					"reserve_key.fast.handle_existing",
					hop_started.elapsed(),
				);
			});
		}
	} else {
		tracing::debug!(
			?actor_id,
			?namespace_id,
			runner_name = %runner_name_selector,
			"skipping actor key optimistic read for local single-replica reservation"
		);
	}

	let new_reservation_id = Id::new_v1(ctx.config().dc_label());
	let reservation_value = reservation_key.serialize(new_reservation_id)?;
	let hop_started = std::time::Instant::now();
	let proposal_result = ctx
		.op(epoxy::ops::propose::Input {
			proposal: Proposal {
				commands: vec![Command {
					kind: CommandKind::CheckAndSetCommand(CheckAndSetCommand {
						key: keys::subspace().pack(&reservation_key),
						expect_one_of: vec![None],
						new_value: Some(reservation_value),
					}),
				}],
			},
			mutable: false,
			purge_cache: false,
			target_replicas: Some(target_replicas),
		})
		.await?;
	log_slow_actor_setup_hop(actor_id, "reserve_key.fast.propose", hop_started.elapsed());

	match proposal_result {
		ProposalResult::Committed => {
			let hop_started = std::time::Instant::now();
			match write_new_actor_key_and_indexes_inner(
				ctx,
				namespace_id,
				&name,
				&key,
				actor_id,
				create_ts,
			)
			.await?
			{
				ReserveActorKeyOutput::Success => {
					log_slow_actor_setup_hop(
						actor_id,
						"reserve_key.fast.write_actor_key_and_indexes",
						hop_started.elapsed(),
					);
					Ok(ReserveKeyOutput::Success)
				}
				ReserveActorKeyOutput::ExistingActor { existing_actor_id } => {
					log_slow_actor_setup_hop(
						actor_id,
						"reserve_key.fast.write_actor_key_and_indexes",
						hop_started.elapsed(),
					);
					Ok(ReserveKeyOutput::KeyExists { existing_actor_id })
				}
			}
		}
		ProposalResult::ConsensusFailed {
			reason: ConsensusFailedReason::ExpectedValueDoesNotMatch { current_value },
		} => {
			if let Some(current_value) = current_value {
				let existing_reservation_id = reservation_key.deserialize(&current_value)?;
				let hop_started = std::time::Instant::now();
				handle_existing_reservation_and_add_indexes_activity(
					ctx,
					existing_reservation_id,
					namespace_id,
					&name,
					&key,
					actor_id,
					create_ts,
				)
				.await
				.inspect(|_| {
					log_slow_actor_setup_hop(
						actor_id,
						"reserve_key.fast.handle_existing",
						hop_started.elapsed(),
					);
				})
			} else {
				bail!("unreachable: current_value should exist")
			}
		}
		res => bail!("consensus failed: {res:?}"),
	}
}

pub(super) async fn reserve_key_and_add_base_keys_and_indexes(
	ctx: &ActivityCtx,
	input: setup::InitStateAndUdbInput,
) -> Result<ReserveKeyOutput> {
	let Some(key) = input.key.clone() else {
		bail!("keyed setup requires an actor key");
	};

	let hop_started = std::time::Instant::now();
	let target_replicas = ctx
		.op(
			crate::ops::runner::list_runner_config_epoxy_replica_ids::Input {
				namespace_id: input.namespace_id,
				runner_name: input.runner_name_selector.clone(),
			},
		)
		.await?
		.replicas;
	log_slow_actor_setup_hop(
		input.actor_id,
		"reserve_key.fast.resolve_target_replicas",
		hop_started.elapsed(),
	);

	if !target_replicas.contains(&ctx.config().epoxy_replica_id())
		&& let Some(replica_id) = target_replicas.first()
	{
		let dc_label = u16::try_from(*replica_id)?;
		return Ok(ReserveKeyOutput::ForwardToDatacenter { dc_label });
	}

	let reservation_key =
		keys::epoxy::ns::ReservationByKeyKey::new(input.namespace_id, input.name.clone(), key);
	let local_replica_id = ctx.config().epoxy_replica_id();
	let is_local_single_replica =
		target_replicas.len() == 1 && target_replicas.first() == Some(&local_replica_id);
	if !is_local_single_replica {
		let hop_started = std::time::Instant::now();
		let optimistic_value = ctx
			.op(epoxy::ops::kv::get_optimistic::Input {
				replica_id: local_replica_id,
				key: keys::subspace().pack(&reservation_key),
				caching_behavior: epoxy::protocol::CachingBehavior::Optimistic,
				target_replicas: Some(target_replicas.clone()),
				save_empty: false,
			})
			.await?
			.value;
		log_slow_actor_setup_hop(
			input.actor_id,
			"reserve_key.fast.get_optimistic",
			hop_started.elapsed(),
		);

		if let Some(value) = optimistic_value {
			let reservation_id = reservation_key.deserialize(&value)?;
			let hop_started = std::time::Instant::now();
			let actor_id = input.actor_id;
			return handle_existing_reservation_and_add_base_keys_activity(
				ctx,
				reservation_id,
				input,
			)
			.await
			.inspect(|_| {
				log_slow_actor_setup_hop(
					actor_id,
					"reserve_key.fast.handle_existing",
					hop_started.elapsed(),
				);
			});
		}
	} else {
		tracing::debug!(
			actor_id = ?input.actor_id,
			namespace_id = ?input.namespace_id,
			runner_name = %input.runner_name_selector,
			"skipping actor key optimistic read for local single-replica reservation"
		);
	}

	let new_reservation_id = Id::new_v1(ctx.config().dc_label());
	let reservation_value = reservation_key.serialize(new_reservation_id)?;
	let hop_started = std::time::Instant::now();
	let proposal_result = ctx
		.op(epoxy::ops::propose::Input {
			proposal: Proposal {
				commands: vec![Command {
					kind: CommandKind::CheckAndSetCommand(CheckAndSetCommand {
						key: keys::subspace().pack(&reservation_key),
						expect_one_of: vec![None],
						new_value: Some(reservation_value),
					}),
				}],
			},
			mutable: false,
			purge_cache: false,
			target_replicas: Some(target_replicas),
		})
		.await?;
	log_slow_actor_setup_hop(
		input.actor_id,
		"reserve_key.fast.propose",
		hop_started.elapsed(),
	);

	match proposal_result {
		ProposalResult::Committed => {
			let hop_started = std::time::Instant::now();
			match write_new_actor_setup_and_indexes_inner(ctx, &input).await? {
				ReserveActorKeyOutput::Success => {
					log_slow_actor_setup_hop(
						input.actor_id,
						"reserve_key.fast.write_actor_setup_and_indexes",
						hop_started.elapsed(),
					);
					Ok(ReserveKeyOutput::Success)
				}
				ReserveActorKeyOutput::ExistingActor { existing_actor_id } => {
					log_slow_actor_setup_hop(
						input.actor_id,
						"reserve_key.fast.write_actor_setup_and_indexes",
						hop_started.elapsed(),
					);
					Ok(ReserveKeyOutput::KeyExists { existing_actor_id })
				}
			}
		}
		ProposalResult::ConsensusFailed {
			reason: ConsensusFailedReason::ExpectedValueDoesNotMatch { current_value },
		} => {
			if let Some(current_value) = current_value {
				let existing_reservation_id = reservation_key.deserialize(&current_value)?;
				let hop_started = std::time::Instant::now();
				let actor_id = input.actor_id;
				handle_existing_reservation_and_add_base_keys_activity(
					ctx,
					existing_reservation_id,
					input,
				)
				.await
				.inspect(|_| {
					log_slow_actor_setup_hop(
						actor_id,
						"reserve_key.fast.handle_existing",
						hop_started.elapsed(),
					);
				})
			} else {
				bail!("unreachable: current_value should exist")
			}
		}
		res => bail!("consensus failed: {res:?}"),
	}
}

async fn handle_existing_reservation_and_add_indexes_activity(
	ctx: &ActivityCtx,
	reservation_id: Id,
	namespace_id: Id,
	name: &str,
	key: &str,
	actor_id: Id,
	create_ts: i64,
) -> Result<ReserveKeyOutput> {
	if reservation_id.label() == ctx.config().dc_label() {
		match reserve_actor_key_and_add_indexes_inner(
			ctx,
			namespace_id,
			name,
			key,
			actor_id,
			create_ts,
		)
		.await?
		{
			ReserveActorKeyOutput::Success => Ok(ReserveKeyOutput::Success),
			ReserveActorKeyOutput::ExistingActor { existing_actor_id } => {
				Ok(ReserveKeyOutput::KeyExists { existing_actor_id })
			}
		}
	} else {
		Ok(ReserveKeyOutput::ForwardToDatacenter {
			dc_label: reservation_id.label(),
		})
	}
}

async fn handle_existing_reservation_and_add_base_keys_activity(
	ctx: &ActivityCtx,
	reservation_id: Id,
	input: setup::InitStateAndUdbInput,
) -> Result<ReserveKeyOutput> {
	if reservation_id.label() == ctx.config().dc_label() {
		match reserve_actor_setup_and_indexes_inner(ctx, &input).await? {
			ReserveActorKeyOutput::Success => Ok(ReserveKeyOutput::Success),
			ReserveActorKeyOutput::ExistingActor { existing_actor_id } => {
				Ok(ReserveKeyOutput::KeyExists { existing_actor_id })
			}
		}
	} else {
		Ok(ReserveKeyOutput::ForwardToDatacenter {
			dc_label: reservation_id.label(),
		})
	}
}

async fn handle_existing_reservation_activity(
	ctx: &ActivityCtx,
	reservation_id: Id,
	namespace_id: Id,
	name: &str,
	key: &str,
	actor_id: Id,
	create_ts: i64,
) -> Result<ReserveKeyOutput> {
	if reservation_id.label() == ctx.config().dc_label() {
		match reserve_actor_key_inner(ctx, namespace_id, name, key, actor_id, create_ts).await? {
			ReserveActorKeyOutput::Success => Ok(ReserveKeyOutput::Success),
			ReserveActorKeyOutput::ExistingActor { existing_actor_id } => {
				Ok(ReserveKeyOutput::KeyExists { existing_actor_id })
			}
		}
	} else {
		Ok(ReserveKeyOutput::ForwardToDatacenter {
			dc_label: reservation_id.label(),
		})
	}
}

async fn handle_existing_reservation(
	ctx: &mut WorkflowCtx,
	reservation_id: Id,
	namespace_id: Id,
	name: String,
	key: String,
	actor_id: Id,
) -> Result<ReserveKeyOutput> {
	if reservation_id.label() == ctx.config().dc_label() {
		let hop_started = std::time::Instant::now();
		let output = ctx
			.activity(ReserveActorKeyInput {
				namespace_id,
				name: name.clone(),
				key: key.clone(),
				actor_id,
				create_ts: ctx.create_ts(),
			})
			.await?;
		log_slow_actor_setup_hop(
			actor_id,
			"reserve_key.write_existing_actor_key",
			hop_started.elapsed(),
		);
		match output {
			ReserveActorKeyOutput::Success => Ok(ReserveKeyOutput::Success),
			ReserveActorKeyOutput::ExistingActor { existing_actor_id } => {
				Ok(ReserveKeyOutput::KeyExists { existing_actor_id })
			}
		}
	} else {
		Ok(ReserveKeyOutput::ForwardToDatacenter {
			dc_label: reservation_id.label(),
		})
	}
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct LookupKeyOptimisticInput {
	namespace_id: Id,
	name: String,
	key: String,
}

#[activity(LookupKeyOptimistic)]
pub async fn lookup_key_optimistic(
	ctx: &ActivityCtx,
	input: &LookupKeyOptimisticInput,
) -> Result<Option<Id>> {
	let reservation_key = keys::epoxy::ns::ReservationByKeyKey::new(
		input.namespace_id,
		input.name.clone(),
		input.key.clone(),
	);
	let value = ctx
		.op(epoxy::ops::kv::get_optimistic::Input {
			replica_id: ctx.config().epoxy_replica_id(),
			key: keys::subspace().pack(&reservation_key),
			caching_behavior: epoxy::protocol::CachingBehavior::Optimistic,
			target_replicas: None,
			save_empty: false,
		})
		.await?
		.value;
	if let Some(value) = value {
		let reservation_id = reservation_key.deserialize(&value)?;
		Ok(Some(reservation_id))
	} else {
		Ok(None)
	}
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct GenerateReservationIdInput {}

#[activity(GenerateReservationId)]
pub async fn generate_reservation_id(
	ctx: &ActivityCtx,
	input: &GenerateReservationIdInput,
) -> Result<Id> {
	Ok(Id::new_v1(ctx.config().dc_label()))
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct ResolveTargetReplicasInput {
	namespace_id: Id,
	runner_name: String,
}

#[activity(ResolveTargetReplicas)]
pub async fn resolve_target_replicas(
	ctx: &ActivityCtx,
	input: &ResolveTargetReplicasInput,
) -> Result<Vec<ReplicaId>> {
	let start = std::time::Instant::now();
	let replicas = ctx
		.op(
			crate::ops::runner::list_runner_config_epoxy_replica_ids::Input {
				namespace_id: input.namespace_id,
				runner_name: input.runner_name.clone(),
			},
		)
		.await?
		.replicas;
	tracing::debug!(
		op_duration_ms = %start.elapsed().as_millis(),
		?replicas,
		"resolve_target_replicas op completed"
	);
	Ok(replicas)
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct ProposeInput {
	namespace_id: Id,
	name: String,
	key: String,
	new_reservation_id: Id,
	actor_id: Id,
	target_replicas: Vec<ReplicaId>,
}

#[activity(Propose)]
pub async fn propose(ctx: &ActivityCtx, input: &ProposeInput) -> Result<ProposalResult> {
	let reservation_key = keys::epoxy::ns::ReservationByKeyKey::new(
		input.namespace_id,
		input.name.clone(),
		input.key.clone(),
	);
	let reservation_value = reservation_key.serialize(input.new_reservation_id)?;

	let proposal_result = ctx
		.op(epoxy::ops::propose::Input {
			proposal: Proposal {
				commands: vec![Command {
					kind: CommandKind::CheckAndSetCommand(CheckAndSetCommand {
						key: keys::subspace().pack(&reservation_key),
						expect_one_of: vec![None],
						new_value: Some(reservation_value),
					}),
				}],
			},
			mutable: false,
			purge_cache: false,
			target_replicas: Some(input.target_replicas.clone()),
		})
		.await?;

	Ok(proposal_result)
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct ReserveActorKeyInput {
	namespace_id: Id,
	name: String,
	key: String,
	actor_id: Id,
	create_ts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub enum ReserveActorKeyOutput {
	Success,
	ExistingActor { existing_actor_id: Id },
}

#[activity(ReserveActorKey)]
pub async fn reserve_actor_key(
	ctx: &ActivityCtx,
	input: &ReserveActorKeyInput,
) -> Result<ReserveActorKeyOutput> {
	reserve_actor_key_inner(
		ctx,
		input.namespace_id,
		&input.name,
		&input.key,
		input.actor_id,
		input.create_ts,
	)
	.await
}

async fn reserve_actor_key_inner(
	ctx: &ActivityCtx,
	namespace_id: Id,
	name: &str,
	key: &str,
	actor_id: Id,
	create_ts: i64,
) -> Result<ReserveActorKeyOutput> {
	let res = ctx
		.udb()?
		.run(|tx| async move {
			let tx = tx.with_subspace(keys::subspace());

			// Check if there are any actors that share the same key that are not destroyed
			let actor_key_subspace = keys::subspace().subspace(&keys::ns::ActorByKeyKey::subspace(
				namespace_id,
				name.to_owned(),
				key.to_owned(),
			));

			let mut stream = tx.get_ranges_keyvalues(
				universaldb::RangeOption {
					mode: StreamingMode::Iterator,
					..(&actor_key_subspace).into()
				},
				Serializable,
			);

			while let Some(entry) = stream.try_next().await? {
				let (idx_key, data) = tx.read_entry::<keys::ns::ActorByKeyKey>(&entry)?;
				if !data.is_destroyed {
					if idx_key.actor_id == actor_id {
						return Ok(ReserveActorKeyOutput::Success);
					}

					return Ok(ReserveActorKeyOutput::ExistingActor {
						existing_actor_id: idx_key.actor_id,
					});
				}
			}

			write_actor_key(
				ctx,
				&tx,
				namespace_id,
				name.to_owned(),
				key.to_owned(),
				create_ts,
				actor_id,
			)?;

			Ok(ReserveActorKeyOutput::Success)
		})
		.custom_instrument(tracing::info_span!("actor_reserve_key_tx"))
		.await?;

	Ok(res)
}

async fn write_new_actor_key_inner(
	ctx: &ActivityCtx,
	namespace_id: Id,
	name: &str,
	key: &str,
	actor_id: Id,
	create_ts: i64,
) -> Result<ReserveActorKeyOutput> {
	let tx_started = std::time::Instant::now();
	let tx_attempts = Arc::new(AtomicUsize::new(0));
	let tx_inner_duration_ms = Arc::new(AtomicU64::new(0));
	let tx_attempts_for_closure = tx_attempts.clone();
	let tx_inner_duration_ms_for_closure = tx_inner_duration_ms.clone();

	ctx.udb()?
		.run(|tx| {
			let tx_attempts_for_attempt = tx_attempts_for_closure.clone();
			let tx_inner_duration_ms_for_attempt = tx_inner_duration_ms_for_closure.clone();
			async move {
				tx_attempts_for_attempt.fetch_add(1, Ordering::AcqRel);
				let attempt_started = std::time::Instant::now();
				let tx = tx.with_subspace(keys::subspace());

				write_actor_key(
					ctx,
					&tx,
					namespace_id,
					name.to_owned(),
					key.to_owned(),
					create_ts,
					actor_id,
				)?;
				tx_inner_duration_ms_for_attempt.fetch_add(
					attempt_started.elapsed().as_millis() as u64,
					Ordering::AcqRel,
				);

				Ok(ReserveActorKeyOutput::Success)
			}
		})
		.custom_instrument(tracing::info_span!("actor_write_new_key_tx"))
		.await?;

	let tx_duration = tx_started.elapsed();
	let tx_inner_duration_ms = tx_inner_duration_ms.load(Ordering::Acquire);
	log_slow_actor_setup_tx_hop(
		actor_id,
		"reserve_key.fast.write_actor_key.udb_run",
		tx_duration,
		tx_attempts.load(Ordering::Acquire),
		tx_inner_duration_ms,
		(tx_duration.as_millis() as u64).saturating_sub(tx_inner_duration_ms),
	);

	Ok(ReserveActorKeyOutput::Success)
}

async fn reserve_actor_key_and_add_indexes_inner(
	ctx: &ActivityCtx,
	namespace_id: Id,
	name: &str,
	key: &str,
	actor_id: Id,
	create_ts: i64,
) -> Result<ReserveActorKeyOutput> {
	let mut state = ctx.state::<super::State>()?;
	state.create_complete_ts = Some(util::timestamp::now());

	let res = ctx
		.udb()?
		.run(|tx| async move {
			let tx = tx.with_subspace(keys::subspace());

			let actor_key_subspace = keys::subspace().subspace(&keys::ns::ActorByKeyKey::subspace(
				namespace_id,
				name.to_owned(),
				key.to_owned(),
			));

			let mut stream = tx.get_ranges_keyvalues(
				universaldb::RangeOption {
					mode: StreamingMode::Iterator,
					..(&actor_key_subspace).into()
				},
				Serializable,
			);

			while let Some(entry) = stream.try_next().await? {
				let (idx_key, data) = tx.read_entry::<keys::ns::ActorByKeyKey>(&entry)?;
				if !data.is_destroyed {
					if idx_key.actor_id == actor_id {
						setup::write_actor_indexes(
							ctx,
							&tx,
							namespace_id,
							name.to_owned(),
							create_ts,
							actor_id,
						)
						.await?;
						return Ok(ReserveActorKeyOutput::Success);
					}

					return Ok(ReserveActorKeyOutput::ExistingActor {
						existing_actor_id: idx_key.actor_id,
					});
				}
			}

			write_actor_key(
				ctx,
				&tx,
				namespace_id,
				name.to_owned(),
				key.to_owned(),
				create_ts,
				actor_id,
			)?;

			setup::write_actor_indexes(
				ctx,
				&tx,
				namespace_id,
				name.to_owned(),
				create_ts,
				actor_id,
			)
			.await?;

			Ok(ReserveActorKeyOutput::Success)
		})
		.custom_instrument(tracing::info_span!("actor_reserve_key_and_indexes_tx"))
		.await?;

	Ok(res)
}

async fn write_new_actor_key_and_indexes_inner(
	ctx: &ActivityCtx,
	namespace_id: Id,
	name: &str,
	key: &str,
	actor_id: Id,
	create_ts: i64,
) -> Result<ReserveActorKeyOutput> {
	let mut state = ctx.state::<super::State>()?;
	state.create_complete_ts = Some(util::timestamp::now());

	let tx_started = std::time::Instant::now();
	let tx_attempts = Arc::new(AtomicUsize::new(0));
	let tx_inner_duration_ms = Arc::new(AtomicU64::new(0));
	let tx_attempts_for_closure = tx_attempts.clone();
	let tx_inner_duration_ms_for_closure = tx_inner_duration_ms.clone();

	ctx.udb()?
		.run(|tx| {
			let tx_attempts_for_attempt = tx_attempts_for_closure.clone();
			let tx_inner_duration_ms_for_attempt = tx_inner_duration_ms_for_closure.clone();
			async move {
				tx_attempts_for_attempt.fetch_add(1, Ordering::AcqRel);
				let attempt_started = std::time::Instant::now();
				let result = async move {
					let tx = tx.with_subspace(keys::subspace());

					write_actor_key(
						ctx,
						&tx,
						namespace_id,
						name.to_owned(),
						key.to_owned(),
						create_ts,
						actor_id,
					)?;
					setup::write_actor_indexes(
						ctx,
						&tx,
						namespace_id,
						name.to_owned(),
						create_ts,
						actor_id,
					)
					.await?;

					Ok(ReserveActorKeyOutput::Success)
				}
				.await;
				tx_inner_duration_ms_for_attempt.fetch_add(
					attempt_started.elapsed().as_millis() as u64,
					Ordering::AcqRel,
				);
				result
			}
		})
		.custom_instrument(tracing::info_span!("actor_write_new_key_and_indexes_tx"))
		.await?;

	let tx_duration = tx_started.elapsed();
	let tx_inner_duration_ms = tx_inner_duration_ms.load(Ordering::Acquire);
	log_slow_actor_setup_tx_hop(
		actor_id,
		"reserve_key.fast.write_actor_key_and_indexes.udb_run",
		tx_duration,
		tx_attempts.load(Ordering::Acquire),
		tx_inner_duration_ms,
		(tx_duration.as_millis() as u64).saturating_sub(tx_inner_duration_ms),
	);

	Ok(ReserveActorKeyOutput::Success)
}

async fn write_new_actor_setup_and_indexes_inner(
	ctx: &ActivityCtx,
	input: &setup::InitStateAndUdbInput,
) -> Result<ReserveActorKeyOutput> {
	let Some(key) = input.key.clone() else {
		bail!("keyed setup requires an actor key");
	};

	let mut state = ctx.state::<super::State>()?;
	state.create_complete_ts = Some(util::timestamp::now());

	let tx_started = std::time::Instant::now();
	let tx_attempts = Arc::new(AtomicUsize::new(0));
	let tx_inner_duration_ms = Arc::new(AtomicU64::new(0));
	let tx_attempts_for_closure = tx_attempts.clone();
	let tx_inner_duration_ms_for_closure = tx_inner_duration_ms.clone();

	ctx.udb()?
		.run(|tx| {
			let tx_attempts_for_attempt = tx_attempts_for_closure.clone();
			let tx_inner_duration_ms_for_attempt = tx_inner_duration_ms_for_closure.clone();
			let key = key.clone();
			async move {
				tx_attempts_for_attempt.fetch_add(1, Ordering::AcqRel);
				let attempt_started = std::time::Instant::now();
				let result = async move {
					let tx = tx.with_subspace(keys::subspace());

					setup::write_actor_base_keys_to_tx(ctx, &tx, input)?;
					write_actor_key(
						ctx,
						&tx,
						input.namespace_id,
						input.name.clone(),
						key,
						input.create_ts,
						input.actor_id,
					)?;
					setup::write_actor_indexes(
						ctx,
						&tx,
						input.namespace_id,
						input.name.clone(),
						input.create_ts,
						input.actor_id,
					)
					.await?;

					Ok(ReserveActorKeyOutput::Success)
				}
				.await;
				tx_inner_duration_ms_for_attempt.fetch_add(
					attempt_started.elapsed().as_millis() as u64,
					Ordering::AcqRel,
				);
				result
			}
		})
		.custom_instrument(tracing::info_span!("actor_write_new_setup_and_indexes_tx"))
		.await?;

	let tx_duration = tx_started.elapsed();
	let tx_inner_duration_ms = tx_inner_duration_ms.load(Ordering::Acquire);
	log_slow_actor_setup_tx_hop(
		input.actor_id,
		"reserve_key.fast.write_actor_setup_and_indexes.udb_run",
		tx_duration,
		tx_attempts.load(Ordering::Acquire),
		tx_inner_duration_ms,
		(tx_duration.as_millis() as u64).saturating_sub(tx_inner_duration_ms),
	);

	Ok(ReserveActorKeyOutput::Success)
}

async fn reserve_actor_setup_and_indexes_inner(
	ctx: &ActivityCtx,
	input: &setup::InitStateAndUdbInput,
) -> Result<ReserveActorKeyOutput> {
	let Some(key) = input.key.clone() else {
		bail!("keyed setup requires an actor key");
	};

	let mut state = ctx.state::<super::State>()?;
	state.create_complete_ts = Some(util::timestamp::now());

	let tx_started = std::time::Instant::now();
	let tx_attempts = Arc::new(AtomicUsize::new(0));
	let tx_inner_duration_ms = Arc::new(AtomicU64::new(0));
	let tx_attempts_for_closure = tx_attempts.clone();
	let tx_inner_duration_ms_for_closure = tx_inner_duration_ms.clone();

	let res = ctx
		.udb()?
		.run(|tx| {
			let tx_attempts_for_attempt = tx_attempts_for_closure.clone();
			let tx_inner_duration_ms_for_attempt = tx_inner_duration_ms_for_closure.clone();
			let key = key.clone();
			async move {
				tx_attempts_for_attempt.fetch_add(1, Ordering::AcqRel);
				let attempt_started = std::time::Instant::now();
				let result = async move {
					let tx = tx.with_subspace(keys::subspace());

					let actor_key_subspace =
						keys::subspace().subspace(&keys::ns::ActorByKeyKey::subspace(
							input.namespace_id,
							input.name.clone(),
							key.clone(),
						));

					let mut stream = tx.get_ranges_keyvalues(
						universaldb::RangeOption {
							mode: StreamingMode::Iterator,
							..(&actor_key_subspace).into()
						},
						Serializable,
					);

					while let Some(entry) = stream.try_next().await? {
						let (idx_key, data) = tx.read_entry::<keys::ns::ActorByKeyKey>(&entry)?;
						if !data.is_destroyed {
							if idx_key.actor_id == input.actor_id {
								setup::write_actor_base_keys_to_tx(ctx, &tx, input)?;
								setup::write_actor_indexes(
									ctx,
									&tx,
									input.namespace_id,
									input.name.clone(),
									input.create_ts,
									input.actor_id,
								)
								.await?;
								return Ok(ReserveActorKeyOutput::Success);
							}

							return Ok(ReserveActorKeyOutput::ExistingActor {
								existing_actor_id: idx_key.actor_id,
							});
						}
					}

					setup::write_actor_base_keys_to_tx(ctx, &tx, input)?;
					write_actor_key(
						ctx,
						&tx,
						input.namespace_id,
						input.name.clone(),
						key,
						input.create_ts,
						input.actor_id,
					)?;
					setup::write_actor_indexes(
						ctx,
						&tx,
						input.namespace_id,
						input.name.clone(),
						input.create_ts,
						input.actor_id,
					)
					.await?;

					Ok(ReserveActorKeyOutput::Success)
				}
				.await;
				tx_inner_duration_ms_for_attempt.fetch_add(
					attempt_started.elapsed().as_millis() as u64,
					Ordering::AcqRel,
				);
				result
			}
		})
		.custom_instrument(tracing::info_span!("actor_reserve_setup_and_indexes_tx"))
		.await?;

	let tx_duration = tx_started.elapsed();
	let tx_inner_duration_ms = tx_inner_duration_ms.load(Ordering::Acquire);
	log_slow_actor_setup_tx_hop(
		input.actor_id,
		"reserve_key.fast.reserve_actor_setup_and_indexes.udb_run",
		tx_duration,
		tx_attempts.load(Ordering::Acquire),
		tx_inner_duration_ms,
		(tx_duration.as_millis() as u64).saturating_sub(tx_inner_duration_ms),
	);

	Ok(res)
}

fn write_actor_key(
	ctx: &ActivityCtx,
	tx: &universaldb::Transaction,
	namespace_id: Id,
	name: String,
	key: String,
	create_ts: i64,
	actor_id: Id,
) -> Result<()> {
	tx.write(
		&keys::ns::ActorByKeyKey::new(namespace_id, name, key, create_ts, actor_id),
		ActorByKeyKeyData {
			workflow_id: ctx.workflow_id(),
			is_destroyed: false,
		},
	)?;

	Ok(())
}
