use anyhow::Result;
use futures_util::TryStreamExt;
use gas::prelude::*;
use universaldb::options::StreamingMode;
use universaldb::utils::IsolationLevel::*;

use crate::{
	executor::{WorkerLane, worker_lane_from_hint},
	keys,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Input {
	pub namespace_id: Id,
	pub name: String,
	#[serde(default)]
	pub lane: Option<String>,
	pub reset_actor_rescheduling: bool,
	pub send_runner_stop_signals: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Output {
	pub runner_workflow_ids: Vec<Id>,
}

pub async fn runner_workflow_ids_for_lane(
	tx: &universaldb::Transaction,
	namespace_id: Id,
	name: &str,
	worker_lane: &WorkerLane,
) -> Result<Vec<Id>> {
	let tx = tx.with_subspace(keys::subspace());
	let mut runner_workflow_ids = Vec::new();

	if worker_lane == &WorkerLane::default() {
		let runner_alloc_subspace = keys::subspace().subspace(
			&keys::ns::RunnerAllocIdxKey::subspace(namespace_id, name.to_owned()),
		);

		let mut stream = tx.get_ranges_keyvalues(
			universaldb::RangeOption {
				mode: StreamingMode::WantAll,
				..(&runner_alloc_subspace).into()
			},
			Snapshot,
		);

		while let Some(entry) = stream.try_next().await? {
			let (_, data) = tx.read_entry::<keys::ns::RunnerAllocIdxKey>(&entry)?;
			push_unique(&mut runner_workflow_ids, data.workflow_id);
		}
	} else {
		let runner_lane_alloc_subspace =
			keys::subspace().subspace(&keys::ns::RunnerLaneAllocIdxKey::subspace(
				namespace_id,
				name.to_owned(),
				worker_lane.as_str().to_owned(),
			));

		let mut stream = tx.get_ranges_keyvalues(
			universaldb::RangeOption {
				mode: StreamingMode::WantAll,
				..(&runner_lane_alloc_subspace).into()
			},
			Snapshot,
		);

		while let Some(entry) = stream.try_next().await? {
			let (_, data) = tx.read_entry::<keys::ns::RunnerLaneAllocIdxKey>(&entry)?;
			push_unique(&mut runner_workflow_ids, data.workflow_id);
		}
	}

	Ok(runner_workflow_ids)
}

fn push_unique(ids: &mut Vec<Id>, id: Id) {
	if !ids.contains(&id) {
		ids.push(id);
	}
}

#[operation]
pub async fn pegboard_runner_drain_lane(ctx: &OperationCtx, input: &Input) -> Result<Output> {
	let runner_workflow_ids = ctx
		.udb()?
		.run(|tx| async move {
			let worker_lane = worker_lane_from_hint(input.lane.as_deref());
			runner_workflow_ids_for_lane(&tx, input.namespace_id, &input.name, &worker_lane).await
		})
		.custom_instrument(tracing::info_span!("drain_lane_tx"))
		.await?;

	if input.send_runner_stop_signals {
		for workflow_id in &runner_workflow_ids {
			ctx.signal(crate::workflows::runner2::Stop {
				reset_actor_rescheduling: input.reset_actor_rescheduling,
			})
			.to_workflow_id(*workflow_id)
			.send()
			.await?;
		}
	}

	Ok(Output {
		runner_workflow_ids,
	})
}
