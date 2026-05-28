use std::{
	sync::{
		Arc,
		atomic::{AtomicU64, AtomicUsize, Ordering},
	},
	time::{Duration, Instant},
};

use gas::prelude::*;
use rivet_data::converted::ActorNameKeyData;
use rivet_types::actors::CrashPolicy;
use universaldb::utils::IsolationLevel::*;

use super::{State, keys as actor_keys, log_slow_actor_setup_hop, log_slow_actor_setup_tx_hop};

use crate::{errors, keys as db_keys};

const MAX_INPUT_SIZE: usize = util::size::mebibytes(4) as usize;

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct ValidateInput {
	pub namespace_id: Id,
	pub name: String,
	pub key: Option<String>,
	pub input: Option<String>,
}

#[activity(Validate)]
pub async fn validate(
	ctx: &ActivityCtx,
	input: &ValidateInput,
) -> Result<std::result::Result<(), errors::Actor>> {
	validate_create(ctx, input).await
}

async fn validate_create(
	ctx: &ActivityCtx,
	input: &ValidateInput,
) -> Result<std::result::Result<(), errors::Actor>> {
	let ns_res = ctx
		.op(namespace::ops::get_global::Input {
			namespace_ids: vec![input.namespace_id],
		})
		.await?;

	if ns_res.is_empty() {
		return Ok(Err(errors::Actor::NamespaceNotFound));
	};

	if input
		.input
		.as_ref()
		.map(|x| x.len() > MAX_INPUT_SIZE)
		.unwrap_or_default()
	{
		return Ok(Err(errors::Actor::InputTooLarge {
			max_size: MAX_INPUT_SIZE,
		}));
	}

	if let Some(k) = &input.key {
		if k.is_empty() {
			return Ok(Err(errors::Actor::EmptyKey));
		}
		if k.len() > 1024 {
			return Ok(Err(errors::Actor::KeyTooLarge {
				max_size: 1024,
				key_preview: util::safe_slice(k, 0, 1024).to_string(),
			}));
		}
	}

	Ok(Ok(()))
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct InitStateAndUdbInput {
	pub actor_id: Id,
	pub name: String,
	pub key: Option<String>,
	pub namespace_id: Id,
	pub runner_name_selector: String,
	#[serde(default)]
	pub lane_hint: Option<String>,
	pub crash_policy: CrashPolicy,
	pub create_ts: i64,
}

#[activity(InitStateAndDb)]
pub async fn insert_state_and_db(ctx: &ActivityCtx, input: &InitStateAndUdbInput) -> Result<()> {
	let activity_started = Instant::now();
	let activity_start_lag_ms = (ctx.ts() - ctx.create_ts()).max(0) as u128;
	log_slow_actor_setup_hop(
		input.actor_id,
		"init_state_and_udb.activity_start_lag",
		Duration::from_millis(activity_start_lag_ms.min(u64::MAX as u128) as u64),
	);

	let hop_started = Instant::now();
	set_initial_state(ctx, input)?;
	log_slow_actor_setup_hop(
		input.actor_id,
		"init_state_and_udb.state",
		hop_started.elapsed(),
	);

	write_actor_base_keys(ctx, input, "init_state_and_udb.udb_run").await?;

	log_slow_actor_setup_hop(
		input.actor_id,
		"init_state_and_udb.activity_body",
		activity_started.elapsed(),
	);

	Ok(())
}

fn set_initial_state(ctx: &ActivityCtx, input: &InitStateAndUdbInput) -> Result<()> {
	let mut state = ctx.state::<Option<State>>()?;

	*state = Some(State::new(
		input.name.clone(),
		input.key.clone(),
		input.namespace_id,
		input.runner_name_selector.clone(),
		input.lane_hint.clone(),
		input.crash_policy,
		input.create_ts,
	));

	Ok(())
}

async fn write_actor_base_keys(
	ctx: &ActivityCtx,
	input: &InitStateAndUdbInput,
	setup_hop: &'static str,
) -> Result<()> {
	let tx_started = Instant::now();
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
				let attempt_started = Instant::now();
				let result = async move {
					let tx = tx.with_subspace(db_keys::subspace());
					write_actor_base_keys_to_tx(ctx, &tx, input)?;
					Ok(())
				}
				.await;
				tx_inner_duration_ms_for_attempt.fetch_add(
					attempt_started.elapsed().as_millis() as u64,
					Ordering::AcqRel,
				);
				result
			}
		})
		.custom_instrument(tracing::info_span!("actor_insert_tx"))
		.await?;

	let tx_duration = tx_started.elapsed();
	let tx_inner_duration_ms = tx_inner_duration_ms.load(Ordering::Acquire);
	log_slow_actor_setup_tx_hop(
		input.actor_id,
		setup_hop,
		tx_duration,
		tx_attempts.load(Ordering::Acquire),
		tx_inner_duration_ms,
		(tx_duration.as_millis() as u64).saturating_sub(tx_inner_duration_ms),
	);

	Ok(())
}

pub(super) fn write_actor_base_keys_to_tx(
	ctx: &ActivityCtx,
	tx: &universaldb::Transaction,
	input: &InitStateAndUdbInput,
) -> Result<()> {
	tx.write(
		&db_keys::actor::CreateTsKey::new(input.actor_id),
		input.create_ts,
	)?;
	tx.write(
		&db_keys::actor::WorkflowIdKey::new(input.actor_id),
		ctx.workflow_id(),
	)?;
	tx.write(
		&db_keys::actor::NamespaceIdKey::new(input.actor_id),
		input.namespace_id,
	)?;
	tx.write(
		&db_keys::actor::RunnerNameSelectorKey::new(input.actor_id),
		input.runner_name_selector.clone(),
	)?;
	if let Some(lane_hint) = &input.lane_hint {
		tx.write(
			&db_keys::actor::LaneHintKey::new(input.actor_id),
			lane_hint.clone(),
		)?;
	}
	tx.write(
		&db_keys::actor::NameKey::new(input.actor_id),
		input.name.clone(),
	)?;
	tx.write(&db_keys::actor::VersionKey::new(input.actor_id), 1)?;

	if let Some(key) = &input.key {
		tx.write(&db_keys::actor::KeyKey::new(input.actor_id), key.clone())?;
	}

	Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct PrepareKeyedCreateInput {
	pub actor_id: Id,
	pub name: String,
	pub key: String,
	pub namespace_id: Id,
	pub runner_name_selector: String,
	#[serde(default)]
	pub lane_hint: Option<String>,
	pub crash_policy: CrashPolicy,
	pub create_ts: i64,
	pub input: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct PrepareKeyedCreateCombinedUdbInput {
	pub actor_id: Id,
	pub name: String,
	pub key: String,
	pub namespace_id: Id,
	pub runner_name_selector: String,
	#[serde(default)]
	pub lane_hint: Option<String>,
	pub crash_policy: CrashPolicy,
	pub create_ts: i64,
	pub input: Option<String>,
}

impl From<PrepareKeyedCreateInput> for PrepareKeyedCreateCombinedUdbInput {
	fn from(input: PrepareKeyedCreateInput) -> Self {
		PrepareKeyedCreateCombinedUdbInput {
			actor_id: input.actor_id,
			name: input.name,
			key: input.key,
			namespace_id: input.namespace_id,
			runner_name_selector: input.runner_name_selector,
			lane_hint: input.lane_hint,
			crash_policy: input.crash_policy,
			create_ts: input.create_ts,
			input: input.input,
		}
	}
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrepareKeyedCreateOutput {
	ValidationFailed {
		error: errors::Actor,
	},
	Complete {
		reserve_result: actor_keys::ReserveKeyOutput,
	},
}

#[activity(PrepareKeyedCreate)]
pub async fn prepare_keyed_create(
	ctx: &ActivityCtx,
	input: &PrepareKeyedCreateInput,
) -> Result<PrepareKeyedCreateOutput> {
	let activity_started = Instant::now();

	let hop_started = Instant::now();
	let validation_res = validate_create(
		ctx,
		&ValidateInput {
			namespace_id: input.namespace_id,
			name: input.name.clone(),
			key: Some(input.key.clone()),
			input: input.input.clone(),
		},
	)
	.await?;
	log_slow_actor_setup_hop(
		input.actor_id,
		"prepare_keyed_create.validate",
		hop_started.elapsed(),
	);

	if let Err(error) = validation_res {
		log_slow_actor_setup_hop(
			input.actor_id,
			"prepare_keyed_create.activity_body",
			activity_started.elapsed(),
		);
		return Ok(PrepareKeyedCreateOutput::ValidationFailed { error });
	}

	let init_input = InitStateAndUdbInput {
		actor_id: input.actor_id,
		name: input.name.clone(),
		key: Some(input.key.clone()),
		namespace_id: input.namespace_id,
		runner_name_selector: input.runner_name_selector.clone(),
		lane_hint: input.lane_hint.clone(),
		crash_policy: input.crash_policy,
		create_ts: input.create_ts,
	};

	let hop_started = Instant::now();
	set_initial_state(ctx, &init_input)?;
	write_actor_base_keys(
		ctx,
		&init_input,
		"prepare_keyed_create.init_state_and_udb.udb_run",
	)
	.await?;
	log_slow_actor_setup_hop(
		input.actor_id,
		"prepare_keyed_create.init_state_and_udb",
		hop_started.elapsed(),
	);

	let hop_started = Instant::now();
	let reserve_result = actor_keys::reserve_key_and_add_indexes_with_create_ts(
		ctx,
		input.namespace_id,
		input.name.clone(),
		input.key.clone(),
		input.actor_id,
		input.runner_name_selector.clone(),
		input.create_ts,
	)
	.await?;
	log_slow_actor_setup_hop(
		input.actor_id,
		"prepare_keyed_create.reserve_key",
		hop_started.elapsed(),
	);
	log_slow_actor_setup_hop(
		input.actor_id,
		"prepare_keyed_create.activity_body",
		activity_started.elapsed(),
	);

	Ok(PrepareKeyedCreateOutput::Complete { reserve_result })
}

#[activity(PrepareKeyedCreateCombinedUdb)]
pub async fn prepare_keyed_create_combined_udb(
	ctx: &ActivityCtx,
	input: &PrepareKeyedCreateCombinedUdbInput,
) -> Result<PrepareKeyedCreateOutput> {
	let activity_started = Instant::now();

	let hop_started = Instant::now();
	let validation_res = validate_create(
		ctx,
		&ValidateInput {
			namespace_id: input.namespace_id,
			name: input.name.clone(),
			key: Some(input.key.clone()),
			input: input.input.clone(),
		},
	)
	.await?;
	log_slow_actor_setup_hop(
		input.actor_id,
		"prepare_keyed_create.validate",
		hop_started.elapsed(),
	);

	if let Err(error) = validation_res {
		log_slow_actor_setup_hop(
			input.actor_id,
			"prepare_keyed_create.activity_body",
			activity_started.elapsed(),
		);
		return Ok(PrepareKeyedCreateOutput::ValidationFailed { error });
	}

	let init_input = InitStateAndUdbInput {
		actor_id: input.actor_id,
		name: input.name.clone(),
		key: Some(input.key.clone()),
		namespace_id: input.namespace_id,
		runner_name_selector: input.runner_name_selector.clone(),
		lane_hint: input.lane_hint.clone(),
		crash_policy: input.crash_policy,
		create_ts: input.create_ts,
	};

	let hop_started = Instant::now();
	set_initial_state(ctx, &init_input)?;
	log_slow_actor_setup_hop(
		input.actor_id,
		"prepare_keyed_create.init_state",
		hop_started.elapsed(),
	);

	let hop_started = Instant::now();
	let reserve_result =
		actor_keys::reserve_key_and_add_base_keys_and_indexes(ctx, init_input).await?;
	log_slow_actor_setup_hop(
		input.actor_id,
		"prepare_keyed_create.reserve_key",
		hop_started.elapsed(),
	);
	log_slow_actor_setup_hop(
		input.actor_id,
		"prepare_keyed_create.activity_body",
		activity_started.elapsed(),
	);

	Ok(PrepareKeyedCreateOutput::Complete { reserve_result })
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct IncrementTotalActorsMetricInput {
	pub actor_id: Id,
	pub namespace_id: Id,
	pub name: String,
}

#[activity(IncrementTotalActorsMetric)]
pub async fn increment_total_actors_metric(
	ctx: &ActivityCtx,
	input: &IncrementTotalActorsMetricInput,
) -> Result<()> {
	ctx.udb()?
		.run(|tx| async move {
			let tx = tx.with_subspace(db_keys::subspace());
			let metric_incremented_key =
				db_keys::actor::TotalActorsMetricIncrementedKey::new(input.actor_id);
			if tx.exists(&metric_incremented_key, Serializable).await? {
				return Ok(());
			}

			namespace::keys::metric::inc(
				&tx.with_subspace(namespace::keys::subspace()),
				input.namespace_id,
				namespace::keys::metric::Metric::TotalActors(input.name.clone()),
				1,
			);
			tx.write(&metric_incremented_key, ())?;

			Ok(())
		})
		.custom_instrument(tracing::info_span!(
			"actor_increment_total_actors_metric_tx"
		))
		.await?;

	Ok(())
}

#[derive(Debug, Serialize, Deserialize, Hash)]
pub struct AddIndexesAndSetCreateCompleteInput {
	pub actor_id: Id,
}

#[activity(AddIndexesAndSetCreateComplete)]
pub async fn add_indexes_and_set_create_complete(
	ctx: &ActivityCtx,
	input: &AddIndexesAndSetCreateCompleteInput,
) -> Result<()> {
	let mut state = ctx.state::<State>()?;

	// Set create complete
	state.create_complete_ts = Some(util::timestamp::now());

	// Populate indexes
	ctx.udb()?
		.run(|tx| {
			let namespace_id = state.namespace_id;
			let name = state.name.clone();
			let create_ts = state.create_ts;
			async move {
				let tx = tx.with_subspace(db_keys::subspace());
				write_actor_indexes(ctx, &tx, namespace_id, name, create_ts, input.actor_id)
					.await?;

				// NOTE: keys::ns::ActorByKeyKey is written in actor_keys.rs when reserved by epoxy

				Ok(())
			}
		})
		.custom_instrument(tracing::info_span!("actor_populate_indexes_tx"))
		.await?;

	Ok(())
}

pub(super) async fn write_actor_indexes(
	ctx: &ActivityCtx,
	tx: &universaldb::Transaction,
	namespace_id: Id,
	name: String,
	create_ts: i64,
	actor_id: Id,
) -> Result<()> {
	tx.write(
		&db_keys::ns::ActiveActorKey::new(namespace_id, name.clone(), create_ts, actor_id),
		ctx.workflow_id(),
	)?;

	tx.write(
		&db_keys::ns::AllActorKey::new(namespace_id, name.clone(), create_ts, actor_id),
		ctx.workflow_id(),
	)?;

	// Write name into namespace actor names list with empty metadata if it doesn't already exist.
	let name_key = db_keys::ns::ActorNameKey::new(namespace_id, name);
	if !tx.exists(&name_key, Serializable).await? {
		tx.write(
			&name_key,
			ActorNameKeyData {
				metadata: serde_json::Map::new(),
			},
		)?;
	}

	Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, Hash)]
pub struct BackfillUdbKeysAndMetricsInput {
	pub actor_id: Id,
}

#[activity(BackfillUdbKeysAndMetrics)]
pub async fn backfill_udb_keys_and_metrics(
	ctx: &ActivityCtx,
	input: &BackfillUdbKeysAndMetricsInput,
) -> Result<()> {
	let state = &ctx.state::<State>()?;

	ctx.udb()?
		.run(|tx| async move {
			let tx = tx.with_subspace(db_keys::subspace());

			tx.write(
				&db_keys::actor::NameKey::new(input.actor_id),
				state.name.clone(),
			)?;
			if let Some(key) = &state.key {
				tx.write(&db_keys::actor::KeyKey::new(input.actor_id), key.clone())?;
			}

			// Update metrics
			let metric_incremented_key =
				db_keys::actor::TotalActorsMetricIncrementedKey::new(input.actor_id);
			if !tx.exists(&metric_incremented_key, Serializable).await? {
				namespace::keys::metric::inc(
					&tx.with_subspace(namespace::keys::subspace()),
					state.namespace_id,
					namespace::keys::metric::Metric::TotalActors(state.name.clone()),
					1,
				);
				tx.write(&metric_incremented_key, ())?;
			}

			Ok(())
		})
		.custom_instrument(tracing::info_span!("actor_insert_tx"))
		.await?;

	Ok(())
}
