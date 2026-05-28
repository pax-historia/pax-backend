use anyhow::Result;
use axum::response::{IntoResponse, Response};
use futures_util::{StreamExt, TryStreamExt};
use indexmap::IndexSet;
use rivet_api_builder::{
	ApiError,
	extract::{Extension, Json, Path, Query},
};
use rivet_api_types::{
	pagination::Pagination,
	runners::{drain_lane::*, list::*, list_names::*},
};
use rivet_api_util::{Method, fanout_to_datacenters, request_remote_datacenter};

use crate::ctx::ApiCtx;

#[utoipa::path(
	get,
	operation_id = "runners_list",
	path = "/runners",
	params(ListQuery),
	responses(
		(status = 200, body = ListResponse),
	),
	security(("bearer_auth" = [])),
)]
#[tracing::instrument(skip_all)]
pub async fn list(Extension(ctx): Extension<ApiCtx>, Query(query): Query<ListQuery>) -> Response {
	match list_inner(ctx, query).await {
		Ok(response) => Json(response).into_response(),
		Err(err) => ApiError::from(err).into_response(),
	}
}

async fn list_inner(ctx: ApiCtx, query: ListQuery) -> Result<ListResponse> {
	ctx.auth().await?;

	// Fanout to all datacenters
	let mut runners =
		fanout_to_datacenters::<ListResponse, _, _, _, _, Vec<rivet_types::runners::Runner>>(
			&ctx,
			"/runners",
			query.clone(),
			|ctx, query| async move { rivet_api_peer::runners::list(ctx, (), query).await },
			|_, res, agg| agg.extend(res.runners),
		)
		.await?;

	// Sort by create ts desc
	runners.sort_by_cached_key(|x| std::cmp::Reverse(x.create_ts));

	// Shorten array since returning all runners from all regions could end up returning `regions *
	// limit` results, which is a lot.
	runners.truncate(query.limit.unwrap_or(100));

	let cursor = runners.last().map(|x| x.create_ts.to_string());

	Ok(ListResponse {
		runners,
		pagination: Pagination { cursor },
	})
}

/// ## Datacenter Round Trips
///
/// 2 round trips:
/// - GET /runners/names (fanout)
/// - [api-peer] namespace::ops::resolve_for_name_global
#[utoipa::path(
	get,
	operation_id = "runners_list_names",
	path = "/runners/names",
	params(ListNamesQuery),
	responses(
		(status = 200, body = ListNamesResponse),
	),
	security(("bearer_auth" = [])),
)]
#[tracing::instrument(skip_all)]
pub async fn list_names(
	Extension(ctx): Extension<ApiCtx>,
	Query(query): Query<ListNamesQuery>,
) -> Response {
	match list_names_inner(ctx, query).await {
		Ok(response) => Json(response).into_response(),
		Err(err) => ApiError::from(err).into_response(),
	}
}

#[tracing::instrument(skip_all)]
async fn list_names_inner(ctx: ApiCtx, query: ListNamesQuery) -> Result<ListNamesResponse> {
	ctx.auth().await?;

	// Prepare peer query for local handler
	let limit = query.limit.unwrap_or(100);

	// Fanout to all datacenters
	let mut all_names = fanout_to_datacenters::<ListNamesResponse, _, _, _, _, IndexSet<String>>(
		&ctx,
		"/runners/names",
		query,
		|ctx, query| async move { rivet_api_peer::runners::list_names(ctx, (), query).await },
		|_, res, agg| agg.extend(res.names),
	)
	.await?
	.into_iter()
	// Apply limit
	.take(limit)
	.collect::<IndexSet<_>>();

	// Sort by name for consistency
	all_names.sort();

	let cursor = all_names.last().map(|x: &String| x.to_string());

	Ok(ListNamesResponse {
		names: all_names.into_iter().collect(),
		pagination: Pagination { cursor },
	})
}

#[utoipa::path(
	post,
	operation_id = "runners_drain_lane",
	path = "/runners/{runner_name}/drain-lane",
	params(
		("runner_name" = String, Path),
		DrainLaneQuery,
	),
	request_body(content = DrainLaneRequest, content_type = "application/json"),
	responses(
		(status = 200, body = DrainLaneResponse),
	),
	security(("bearer_auth" = [])),
)]
#[tracing::instrument(skip_all)]
pub async fn drain_lane(
	Extension(ctx): Extension<ApiCtx>,
	Path(path): Path<DrainLanePath>,
	Query(query): Query<DrainLaneQuery>,
	Json(body): Json<DrainLaneRequest>,
) -> Response {
	match drain_lane_inner(ctx, path, query, body).await {
		Ok(response) => Json(response).into_response(),
		Err(err) => ApiError::from(err).into_response(),
	}
}

#[tracing::instrument(skip_all)]
async fn drain_lane_inner(
	ctx: ApiCtx,
	path: DrainLanePath,
	query: DrainLaneQuery,
	body: DrainLaneRequest,
) -> Result<DrainLaneResponse> {
	ctx.auth().await?;

	let dcs = ctx
		.config()
		.topology()
		.datacenters
		.iter()
		.cloned()
		.collect::<Vec<_>>();

	let runner_workflow_ids = futures_util::stream::iter(dcs)
		.map(|dc| {
			let ctx = ctx.clone();
			let path = path.clone();
			let query = query.clone();
			let body = body.clone();

			async move {
				let response = if ctx.config().dc_label() == dc.datacenter_label {
					rivet_api_peer::runners::drain_lane(
						ctx.clone().into(),
						path.clone(),
						query.clone(),
						body.clone(),
					)
					.await?
				} else {
					request_remote_datacenter::<DrainLaneResponse>(
						ctx.config(),
						dc.datacenter_label,
						&format!("/runners/{}/drain-lane", path.runner_name),
						Method::POST,
						Some(&query),
						Some(&body),
					)
					.await?
				};

				anyhow::Ok(response.runner_workflow_ids)
			}
		})
		.buffer_unordered(16)
		.try_collect::<Vec<_>>()
		.await?
		.into_iter()
		.flatten()
		.collect();

	Ok(DrainLaneResponse {
		runner_workflow_ids,
	})
}
