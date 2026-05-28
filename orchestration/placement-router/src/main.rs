// orchestration/placement-router — substrate placement, no WS data path.
//
// HTTP endpoints:
//   GET /health                       -> {status, version}
//   GET /games/:id/placement?userId=  -> { shardUrl, webSocketUrl, placementToken,
//                                          expiresAt, shardId, serverTimings }
//
// Algorithm (smoke-grade port of pax-sharded-spike/orchestration/router-placement,
// with all 50k-game scale gymnastics stripped):
//
//   1. Read games:<id> from Redis -> get bundleName
//   2. Read bundles:<bundleName> from Redis -> get runtimeContractRequired
//   3. SCAN shards:* from Redis -> all shard rows
//   4. Filter: healthy && acceptingWakes && lastSeenAt within 30s &&
//              runtimeContractsSupported contains runtimeContractRequired
//      (README guarantee #16 — the new bit vs pax-sharded-spike)
//   5. Score = effectiveLoad*0.45 + activeGames*0.35 + cpu*0.15 + wakeRate*0.05
//      (same weights as pax-sharded-spike/orchestration/router-placement/src/placement.rs)
//   6. Sign HS256 JWT { gameId, shardId, userId, bundleName, runId, traceId, exp } with PAX_JWT_SECRET
//   7. Build webSocketUrl using the shard's recorded rivet { namespace, actorName,
//      runnerName, adminTokenHint } and the gateway URL pattern from the
//      rocks-physics smoke harness.
//   8. Return JSON.
//
// Skipped vs the production pax-sharded-spike router:
//   - No active-game directory stickiness (smoke is a single game).
//   - No atomic SET NX + Lua claim (no contention).
//   - No recent-wakes accounting.
//   - No PUT /actors call (we use Rivet's getOrCreate URL pattern so no
//     pre-creation step is needed).

use std::collections::BTreeMap;
use std::env;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use jsonwebtoken::{encode, EncodingKey, Header};
use opentelemetry::global;
use opentelemetry::propagation::Extractor;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::propagation::TraceContextPropagator;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use tracing::{info, warn, Span};
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const SHARD_FRESHNESS_MS: u64 = 30_000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Config {
    redis_url: String,
    bind: SocketAddr,
    jwt_secret: String,
    placement_token_ttl_secs: u64,
}

impl Config {
    fn from_env() -> Result<Self> {
        let bind: SocketAddr = env::var("PAX_ROUTER_BIND")
            .unwrap_or_else(|_| "127.0.0.1:9080".to_string())
            .parse()
            .context("PAX_ROUTER_BIND not a socketaddr")?;
        Ok(Self {
            redis_url: env::var("REDIS_URL")
                .unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string()),
            bind,
            jwt_secret: env::var("PAX_JWT_SECRET")
                .unwrap_or_else(|_| "local-dev-secret".to_string()),
            placement_token_ttl_secs: env::var("PAX_PLACEMENT_TOKEN_TTL_SECONDS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(120),
        })
    }
}

// ---------------------------------------------------------------------------
// Redis row shapes (must match what the parent-actor writes)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct GameRecord {
    #[serde(rename = "gameId")]
    _game_id: String,
    #[serde(rename = "bundleName")]
    bundle_name: String,
}

#[derive(Debug, Deserialize)]
struct BundleRecord {
    #[serde(rename = "bundleName")]
    _bundle_name: String,
    manifest: BundleManifest,
}

#[derive(Debug, Deserialize)]
struct BundleManifest {
    #[serde(rename = "compatTagProduced")]
    _compat_tag_produced: String,
    #[serde(rename = "compatTagsAccepted")]
    _compat_tags_accepted: Vec<String>,
    #[serde(rename = "runtimeContractRequired")]
    runtime_contract_required: u32,
}

#[derive(Debug, Clone, Deserialize)]
struct ShardRow {
    #[serde(rename = "shardId")]
    shard_id: String,
    url: String,
    healthy: bool,
    #[serde(rename = "acceptingWakes")]
    accepting_wakes: bool,
    #[serde(rename = "runtimeContractsSupported")]
    runtime_contracts_supported: [u32; 2],
    #[serde(rename = "activeGames", default)]
    active_games: u32,
    #[serde(rename = "cpuPct", default)]
    cpu_pct: f64,
    #[serde(rename = "recentWakeRate", default)]
    recent_wake_rate: u32,
    #[serde(rename = "lastSeenAt")]
    last_seen_at: u64,
    rivet: ShardRivetInfo,
}

#[derive(Debug, Clone, Deserialize)]
struct ShardRivetInfo {
    namespace: String,
    #[serde(rename = "runnerName")]
    runner_name: String,
    #[serde(rename = "actorName")]
    actor_name: String,
    #[serde(rename = "adminTokenHint")]
    admin_token_hint: String,
}

// ---------------------------------------------------------------------------
// Wire response
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
struct PlacementResponse {
    #[serde(rename = "gameId")]
    game_id: String,
    #[serde(rename = "shardId")]
    shard_id: String,
    #[serde(rename = "runtimeContractRequired")]
    runtime_contract_required: u32,
    #[serde(rename = "runtimeContractsSupported")]
    runtime_contracts_supported: [u32; 2],
    #[serde(rename = "shardUrl")]
    shard_url: String,
    #[serde(rename = "webSocketUrl")]
    web_socket_url: String,
    #[serde(rename = "placementToken")]
    placement_token: String,
    #[serde(rename = "expiresAt")]
    expires_at: u64,
    #[serde(rename = "runId")]
    run_id: String,
    #[serde(rename = "traceId")]
    trace_id: String,
    #[serde(rename = "bundleName")]
    bundle_name: String,
    #[serde(rename = "serverTimings")]
    server_timings: BTreeMap<String, u128>,
}

#[derive(Debug, Serialize)]
struct PlacementClaims {
    #[serde(rename = "gameId")]
    game_id: String,
    #[serde(rename = "shardId")]
    shard_id: String,
    #[serde(rename = "userId")]
    user_id: String,
    #[serde(rename = "bundleName")]
    bundle_name: String,
    #[serde(rename = "runId")]
    run_id: String,
    #[serde(rename = "traceId")]
    trace_id: String,
    exp: u64,
}

#[derive(Debug, Deserialize)]
struct PlacementQuery {
    #[serde(rename = "userId", default)]
    user_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
enum PlacementError {
    #[error("game {0} not found")]
    GameNotFound(String),
    #[error("bundle {0} not found")]
    BundleNotFound(String),
    #[error("no eligible shards for runtime contract {required} (saw {seen} shard(s) total)")]
    NoEligibleShards { required: u32, seen: usize },
    #[error("contract out of range: bundle requires {required}, no shard supports it")]
    ContractOutOfRange { required: u32 },
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for PlacementError {
    fn into_response(self) -> Response {
        let (status, code) = match &self {
            PlacementError::GameNotFound(_) => (StatusCode::NOT_FOUND, "gameNotFound"),
            PlacementError::BundleNotFound(_) => (StatusCode::NOT_FOUND, "bundleNotFound"),
            PlacementError::NoEligibleShards { .. } => {
                (StatusCode::SERVICE_UNAVAILABLE, "noEligibleShards")
            }
            PlacementError::ContractOutOfRange { .. } => {
                (StatusCode::CONFLICT, "contractOutOfRange")
            }
            PlacementError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
        };
        let detail = match &self {
            PlacementError::NoEligibleShards { required, seen } => serde_json::json!({
                "required": required,
                "seen": seen,
            }),
            PlacementError::ContractOutOfRange { required } => serde_json::json!({
                "required": required,
            }),
            _ => serde_json::json!({}),
        };
        let body = serde_json::json!({
            "ok": false,
            "error": code,
            "message": self.to_string(),
            "detail": detail,
        });
        (status, Json(body)).into_response()
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct AppState {
    redis: redis::Client,
    cfg: Arc<Config>,
    metrics: Arc<RouterMetrics>,
}

#[derive(Default)]
struct RouterMetrics {
    placement_requests_total: AtomicU64,
    placement_accepted_total: AtomicU64,
    placement_rejected_total: AtomicU64,
    placement_contract_rejected_total: AtomicU64,
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "runtime": "placement-router",
        "version": VERSION,
    }))
}

async fn metrics(State(state): State<AppState>) -> impl IntoResponse {
    let body = format!(
        concat!(
            "# HELP pax_placement_requests_total Total placement requests received.\n",
            "# TYPE pax_placement_requests_total counter\n",
            "pax_placement_requests_total {}\n",
            "# HELP pax_placement_accepted_total Total successful placements.\n",
            "# TYPE pax_placement_accepted_total counter\n",
            "pax_placement_accepted_total {}\n",
            "# HELP pax_placement_rejected_total Total placement requests rejected by router gates.\n",
            "# TYPE pax_placement_rejected_total counter\n",
            "pax_placement_rejected_total {}\n",
            "# HELP pax_placement_contract_rejected_total Placements rejected by runtime contract gate.\n",
            "# TYPE pax_placement_contract_rejected_total counter\n",
            "pax_placement_contract_rejected_total {}\n",
            "# HELP pax_placement_router_build_info Placement router build metadata.\n",
            "# TYPE pax_placement_router_build_info gauge\n",
            "pax_placement_router_build_info{{version=\"{}\"}} 1\n",
        ),
        state.metrics.placement_requests_total.load(Ordering::Relaxed),
        state.metrics.placement_accepted_total.load(Ordering::Relaxed),
        state.metrics.placement_rejected_total.load(Ordering::Relaxed),
        state.metrics.placement_contract_rejected_total.load(Ordering::Relaxed),
        VERSION,
    );
    (
        [("content-type", "text/plain; version=0.0.4; charset=utf-8")],
        body,
    )
}

#[tracing::instrument(
    name = "router.placement",
    skip(state, q, headers),
    err,
    fields(
        otel.kind = "server",
        game_id = %game_id,
        user_id = tracing::field::Empty,
        trace_id = tracing::field::Empty,
        run_id = tracing::field::Empty,
        bundle_name = tracing::field::Empty,
        runtime_contract = tracing::field::Empty,
        shard_id = tracing::field::Empty,
    )
)]
async fn placement(
    State(state): State<AppState>,
    Path(game_id): Path<String>,
    Query(q): Query<PlacementQuery>,
    headers: HeaderMap,
) -> Result<Json<PlacementResponse>, PlacementError> {
    let _ = Span::current().set_parent(global::get_text_map_propagator(|propagator| {
        propagator.extract(&HeaderExtractor(&headers))
    }));
    let mut timings = BTreeMap::new();
    let t0 = std::time::Instant::now();
    state
        .metrics
        .placement_requests_total
        .fetch_add(1, Ordering::Relaxed);

    let mut conn = state
        .redis
        .get_multiplexed_async_connection()
        .await
        .context("redis connect")?;

    // 1. Game record
    let game_raw: Option<String> = conn
        .get(format!("games:{}", game_id))
        .await
        .context("redis games get")?;
    let game_raw = game_raw.ok_or_else(|| PlacementError::GameNotFound(game_id.clone()))?;
    let game: GameRecord = serde_json::from_str(&game_raw).context("games:* json parse")?;
    timings.insert("gameLookupMs".to_string(), t0.elapsed().as_millis());

    // 2. Bundle record
    let t1 = std::time::Instant::now();
    let bundle_raw: Option<String> = conn
        .get(format!("bundles:{}", game.bundle_name))
        .await
        .context("redis bundles get")?;
    let bundle_raw =
        bundle_raw.ok_or_else(|| PlacementError::BundleNotFound(game.bundle_name.clone()))?;
    let bundle: BundleRecord = serde_json::from_str(&bundle_raw).context("bundles:* json parse")?;
    timings.insert("bundleLookupMs".to_string(), t1.elapsed().as_millis());

    // 3. SCAN shards:*
    let t2 = std::time::Instant::now();
    let shards = fetch_shards(&mut conn).await?;
    timings.insert("shardScanMs".to_string(), t2.elapsed().as_millis());

    // 4. Filter — README guarantee #16
    let required = bundle.manifest.runtime_contract_required;
    Span::current().record("bundle_name", tracing::field::display(&game.bundle_name));
    Span::current().record("runtime_contract", required);
    let now_ms = now_ms();
    let eligible: Vec<&ShardRow> = shards
        .iter()
        .filter(|s| {
            let contract_ok = s.runtime_contracts_supported[0] <= required
                && required <= s.runtime_contracts_supported[1];
            let fresh = now_ms.saturating_sub(s.last_seen_at) <= SHARD_FRESHNESS_MS;
            s.healthy && s.accepting_wakes && fresh && contract_ok
        })
        .collect();

    if eligible.is_empty() {
        let any_supports = shards.iter().any(|s| {
            s.runtime_contracts_supported[0] <= required
                && required <= s.runtime_contracts_supported[1]
        });
        if !any_supports && !shards.is_empty() {
            state
                .metrics
                .placement_rejected_total
                .fetch_add(1, Ordering::Relaxed);
            state
                .metrics
                .placement_contract_rejected_total
                .fetch_add(1, Ordering::Relaxed);
            return Err(PlacementError::ContractOutOfRange { required });
        }
        state
            .metrics
            .placement_rejected_total
            .fetch_add(1, Ordering::Relaxed);
        return Err(PlacementError::NoEligibleShards {
            required,
            seen: shards.len(),
        });
    }

    // 5. Score (cold-shard wins).
    let target_games_per_shard = 100.0_f64;
    let mut best: Option<(f64, &ShardRow)> = None;
    for s in &eligible {
        let effective_load = (s.active_games as f64 / target_games_per_shard).clamp(0.0, 2.0);
        let active_games_score = (s.active_games as f64 / target_games_per_shard).clamp(0.0, 2.0);
        let cpu = (s.cpu_pct / 100.0).clamp(0.0, 1.0);
        let wake_rate = (s.recent_wake_rate as f64 / 50.0).clamp(0.0, 2.0);
        let score =
            effective_load * 0.45 + active_games_score * 0.35 + cpu * 0.15 + wake_rate * 0.05;
        match &best {
            None => best = Some((score, s)),
            Some((b, _)) if score < *b => best = Some((score, s)),
            _ => {}
        }
    }
    let (_score, picked) = best.expect("eligible non-empty checked above");

    // 6. Sign JWT
    let t6 = std::time::Instant::now();
    let run_id = format!("run_{}_{}", now_ms, uuid::Uuid::new_v4().simple());
    let trace_id = trace_id_from_headers(&headers)
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let user_id = q.user_id.unwrap_or_else(|| "anon".to_string());
    let span = Span::current();
    span.record("trace_id", tracing::field::display(&trace_id));
    span.record("run_id", tracing::field::display(&run_id));
    span.record("user_id", tracing::field::display(&user_id));
    span.record("shard_id", tracing::field::display(&picked.shard_id));
    let claims = PlacementClaims {
        game_id: game_id.clone(),
        shard_id: picked.shard_id.clone(),
        user_id: user_id.clone(),
        bundle_name: game.bundle_name.clone(),
        run_id: run_id.clone(),
        trace_id: trace_id.clone(),
        exp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            + state.cfg.placement_token_ttl_secs,
    };
    let token = encode(
        &Header::new(jsonwebtoken::Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(state.cfg.jwt_secret.as_bytes()),
    )
    .context("jwt encode")?;
    timings.insert("jwtSignMs".to_string(), t6.elapsed().as_millis());

    // 7. webSocketUrl
    let admin_token =
        env::var(&picked.rivet.admin_token_hint).unwrap_or_else(|_| "dev".to_string());
    let ws_url = build_ws_url(picked, &game_id, &token, &admin_token, &user_id);

    timings.insert("totalMs".to_string(), t0.elapsed().as_millis());
    state
        .metrics
        .placement_accepted_total
        .fetch_add(1, Ordering::Relaxed);

    Ok(Json(PlacementResponse {
        game_id,
        shard_id: picked.shard_id.clone(),
        runtime_contract_required: required,
        runtime_contracts_supported: picked.runtime_contracts_supported,
        shard_url: picked.url.clone(),
        web_socket_url: ws_url,
        placement_token: token,
        expires_at: claims.exp,
        run_id,
        trace_id,
        bundle_name: game.bundle_name,
        server_timings: timings,
    }))
}

fn trace_id_from_headers(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get("traceparent")?.to_str().ok()?;
    let mut parts = raw.split('-');
    let version = parts.next()?;
    let trace_id = parts.next()?;
    let span_id = parts.next()?;
    let flags = parts.next()?;
    if parts.next().is_some()
        || version.len() != 2
        || trace_id.len() != 32
        || span_id.len() != 16
        || flags.len() != 2
        || trace_id == "00000000000000000000000000000000"
        || !trace_id.chars().all(|ch| ch.is_ascii_hexdigit())
        || !span_id.chars().all(|ch| ch.is_ascii_hexdigit())
        || !flags.chars().all(|ch| ch.is_ascii_hexdigit())
    {
        return None;
    }
    Some(trace_id.to_ascii_lowercase())
}

struct HeaderExtractor<'a>(&'a HeaderMap);

impl Extractor for HeaderExtractor<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|value| value.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(|name| name.as_str()).collect()
    }
}

async fn fetch_shards(conn: &mut redis::aio::MultiplexedConnection) -> Result<Vec<ShardRow>> {
    // SCAN cursor over shards:*
    let mut cursor: u64 = 0;
    let mut keys: Vec<String> = Vec::new();
    loop {
        let (next, batch): (u64, Vec<String>) = redis::cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg("shards:*")
            .arg("COUNT")
            .arg(100u32)
            .query_async(conn)
            .await
            .context("redis scan shards:*")?;
        keys.extend(batch);
        if next == 0 {
            break;
        }
        cursor = next;
    }
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let raws: Vec<Option<String>> = conn.mget(&keys).await.context("redis mget shards")?;
    let mut out = Vec::with_capacity(raws.len());
    for (k, raw) in keys.iter().zip(raws.iter()) {
        let Some(raw) = raw else { continue };
        match serde_json::from_str::<ShardRow>(raw) {
            Ok(row) => out.push(row),
            Err(err) => warn!(key = %k, error = %err, "skipping malformed shard row"),
        }
    }
    Ok(out)
}

fn build_ws_url(
    shard: &ShardRow,
    game_id: &str,
    placement_token: &str,
    admin_token: &str,
    user_id: &str,
) -> String {
    let base = shard
        .url
        .replacen("http://", "ws://", 1)
        .replacen("https://", "wss://", 1);
    let path = format!("/gateway/{}", url_encode(&shard.rivet.actor_name));
    let qs = [
        ("rvt-namespace", shard.rivet.namespace.as_str()),
        ("rvt-method", "getOrCreate"),
        ("rvt-runner", shard.rivet.runner_name.as_str()),
        ("rvt-key", game_id),
        ("rvt-crash-policy", "sleep"),
        ("rvt-token", admin_token),
        ("placementToken", placement_token),
        ("userId", user_id),
    ]
    .iter()
    .map(|(k, v)| format!("{}={}", k, url_encode(v)))
    .collect::<Vec<_>>()
    .join("&");
    format!("{}{}?{}", base, path, qs)
}

fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main]
async fn main() -> Result<()> {
    let tracer_provider = init_tracing()?;

    let cfg = Arc::new(Config::from_env()?);
    info!(bind = %cfg.bind, redis = %cfg.redis_url, "placement-router boot");

    let redis = redis::Client::open(cfg.redis_url.as_str()).context("redis open")?;
    // Eager ping so a bad URL fails fast at boot
    let mut probe = redis
        .get_multiplexed_async_connection()
        .await
        .context("redis connect probe")?;
    let pong: String = redis::cmd("PING")
        .query_async(&mut probe)
        .await
        .context("redis ping")?;
    info!(pong = %pong, "redis ok");

    let state = AppState {
        redis,
        cfg: cfg.clone(),
        metrics: Arc::new(RouterMetrics::default()),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .route("/games/:game_id/placement", get(placement))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(cfg.bind)
        .await
        .context("bind")?;
    info!(addr = %cfg.bind, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .context("serve")?;

    if let Some(provider) = tracer_provider {
        if let Err(err) = provider.shutdown() {
            warn!(error = ?err, "failed to shut down OpenTelemetry tracer provider");
        }
    }

    let _ = tokio::time::sleep(Duration::from_millis(50)).await;
    Ok(())
}

fn init_tracing() -> Result<Option<SdkTracerProvider>> {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let fmt_layer = tracing_subscriber::fmt::layer();

    if otel_disabled() {
        tracing_subscriber::registry()
            .with(env_filter)
            .with(fmt_layer)
            .init();
        return Ok(None);
    }

    global::set_text_map_propagator(TraceContextPropagator::new());
    let endpoint = env::var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
        .or_else(|_| env::var("OTEL_EXPORTER_OTLP_ENDPOINT"))
        .or_else(|_| env::var("PAX_OTEL_EXPORTER_OTLP_ENDPOINT"))
        .unwrap_or_else(|_| "http://127.0.0.1:4317".to_string());
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_tonic()
        .with_endpoint(endpoint)
        .build()
        .context("build OTLP span exporter")?;
    let tracer_provider = SdkTracerProvider::builder()
        .with_resource(router_resource())
        .with_batch_exporter(exporter)
        .build();
    let tracer = tracer_provider.tracer("pax-placement-router");
    let otel_layer = tracing_opentelemetry::layer().with_tracer(tracer);
    global::set_tracer_provider(tracer_provider.clone());

    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt_layer)
        .with(otel_layer)
        .init();
    Ok(Some(tracer_provider))
}

fn otel_disabled() -> bool {
    env::var("PAX_OBSERVABILITY").is_ok_and(|value| value == "off")
        || env::var("OTEL_SDK_DISABLED").is_ok_and(|value| value == "true")
        || env::var("OTEL_TRACES_EXPORTER").is_ok_and(|value| value == "none")
}

fn router_resource() -> Resource {
    let mut attrs = vec![
        KeyValue::new("service.namespace", "pax-backend"),
        KeyValue::new(
            "deployment.environment.name",
            env::var("PAX_ENVIRONMENT")
                .or_else(|_| env::var("RUST_ENV"))
                .unwrap_or_else(|_| "development".to_string()),
        ),
        KeyValue::new("pax.zone", "orchestration"),
        KeyValue::new(
            "pax.runtime_contract",
            env::var("PAX_RUNTIME_CONTRACT").unwrap_or_else(|_| "1".to_string()),
        ),
    ];
    push_env_attr(&mut attrs, "pax.run_id", "PAX_RUN_ID");
    push_env_attr(&mut attrs, "fly.app", "FLY_APP_NAME");
    push_env_attr(&mut attrs, "fly.machine_id", "FLY_MACHINE_ID");
    push_env_attr(&mut attrs, "fly.region", "FLY_REGION");

    Resource::builder()
        .with_service_name("pax-placement-router")
        .with_attributes(attrs)
        .build()
}

fn push_env_attr(attrs: &mut Vec<KeyValue>, key: &'static str, env_key: &str) {
    if let Ok(value) = env::var(env_key) {
        if !value.is_empty() {
            attrs.push(KeyValue::new(key, value));
        }
    }
}
