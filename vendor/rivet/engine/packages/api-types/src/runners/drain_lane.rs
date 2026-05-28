use gas::prelude::*;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

#[derive(Debug, Serialize, Deserialize, Clone, IntoParams)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Path)]
pub struct DrainLanePath {
	pub runner_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, IntoParams)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct DrainLaneQuery {
	pub namespace: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, ToSchema)]
#[serde(deny_unknown_fields)]
#[schema(as = RunnersDrainLaneRequest)]
pub struct DrainLaneRequest {
	#[serde(default)]
	pub lane: Option<String>,
	#[serde(default)]
	pub reset_actor_rescheduling: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
#[schema(as = RunnersDrainLaneResponse)]
pub struct DrainLaneResponse {
	pub runner_workflow_ids: Vec<Id>,
}
