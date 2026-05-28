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
//   6. Sign HS256 JWT { gameId, shardId, userId, bundleName, runId, exp } with PAX_JWT_SECRET
//   7. Build webSocketUrl using the shard's recorded rivet { namespace, actorName,
//      runnerName, adminTokenHint } and the gateway URL pattern from the
//      rocks-physics smoke harness.
//   8. Return JSON.
//
// Skipped vs the production pax-sharded-spike router:
//   - No active-game directory stickiness (smoke is a single game).
//   - No atomic SET NX + Lua claim (no contention).
//   - No recent-wakes accounting.
//   - No metrics endpoint (defer).
//   - No PUT /actors call (we use Rivet's getOrCreate URL pattern so no
//     pre-creation step is needed).

use std::collections::BTreeMap;
use std::env;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use jsonwebtoken::{encode, EncodingKey, Header};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

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
            redis_url: env::var("REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379".to_string()),
            bind,
            jwt_secret: env::var("PAX_JWT_SECRET").unwrap_or_else(|_| "local-dev-secret".to_string()),
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
            PlacementError::NoEligibleShards { .. } => (StatusCode::SERVICE_UNAVAILABLE, "noEligibleShards"),
            PlacementError::ContractOutOfRange { .. } => (StatusCode::CONFLICT, "contractOutOfRange"),
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
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({
        "status": "ok",
        "runtime": "placement-router",
        "version": VERSION,
    }))
}

async fn placement(
    State(state): State<AppState>,
    Path(game_id): Path<String>,
    Query(q): Query<PlacementQuery>,
) -> Result<Json<PlacementResponse>, PlacementError> {
    let mut timings = BTreeMap::new();
    let t0 = std::time::Instant::now();

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
    let game: GameRecord = serde_json::from_str(&game_raw)
        .context("games:* json parse")?;
    timings.insert("gameLookupMs".to_string(), t0.elapsed().as_millis());

    // 2. Bundle record
    let t1 = std::time::Instant::now();
    let bundle_raw: Option<String> = conn
        .get(format!("bundles:{}", game.bundle_name))
        .await
        .context("redis bundles get")?;
    let bundle_raw = bundle_raw.ok_or_else(|| PlacementError::BundleNotFound(game.bundle_name.clone()))?;
    let bundle: BundleRecord = serde_json::from_str(&bundle_raw)
        .context("bundles:* json parse")?;
    timings.insert("bundleLookupMs".to_string(), t1.elapsed().as_millis());

    // 3. SCAN shards:*
    let t2 = std::time::Instant::now();
    let shards = fetch_shards(&mut conn).await?;
    timings.insert("shardScanMs".to_string(), t2.elapsed().as_millis());

    // 4. Filter — README guarantee #16
    let required = bundle.manifest.runtime_contract_required;
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
        let any_supports = shards
            .iter()
            .any(|s| s.runtime_contracts_supported[0] <= required && required <= s.runtime_contracts_supported[1]);
        if !any_supports && !shards.is_empty() {
            return Err(PlacementError::ContractOutOfRange { required });
        }
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
        let score = effective_load * 0.45 + active_games_score * 0.35 + cpu * 0.15 + wake_rate * 0.05;
        match &best {
            None => best = Some((score, s)),
            Some((b, _)) if score < *b => best = Some((score, s)),
            _ => {}
        }
    }
    let (_score, picked) = best.expect("eligible non-empty checked above");

    // 6. Sign JWT
    let t6 = std::time::Instant::now();
    let run_id = format!(
        "run_{}_{}",
        now_ms,
        uuid::Uuid::new_v4().simple()
    );
    let user_id = q.user_id.unwrap_or_else(|| "anon".to_string());
    let claims = PlacementClaims {
        game_id: game_id.clone(),
        shard_id: picked.shard_id.clone(),
        user_id: user_id.clone(),
        bundle_name: game.bundle_name.clone(),
        run_id: run_id.clone(),
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
    let admin_token = env::var(&picked.rivet.admin_token_hint)
        .unwrap_or_else(|_| "dev".to_string());
    let ws_url = build_ws_url(picked, &game_id, &token, &admin_token, &user_id);

    timings.insert("totalMs".to_string(), t0.elapsed().as_millis());

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
        bundle_name: game.bundle_name,
        server_timings: timings,
    }))
}

async fn fetch_shards(
    conn: &mut redis::aio::MultiplexedConnection,
) -> Result<Vec<ShardRow>> {
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
    let base = shard.url.replacen("http://", "ws://", 1).replacen("https://", "wss://", 1);
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
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")))
        .init();

    let cfg = Arc::new(Config::from_env()?);
    info!(bind = %cfg.bind, redis = %cfg.redis_url, "placement-router boot");

    let redis = redis::Client::open(cfg.redis_url.as_str()).context("redis open")?;
    // Eager ping so a bad URL fails fast at boot
    let mut probe = redis
        .get_multiplexed_async_connection()
        .await
        .context("redis connect probe")?;
    let pong: String = redis::cmd("PING").query_async(&mut probe).await.context("redis ping")?;
    info!(pong = %pong, "redis ok");

    let state = AppState { redis, cfg: cfg.clone() };
    let app = Router::new()
        .route("/health", get(health))
        .route("/games/:game_id/placement", get(placement))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(cfg.bind).await.context("bind")?;
    info!(addr = %cfg.bind, "listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .context("serve")?;

    let _ = tokio::time::sleep(Duration::from_millis(50)).await;
    Ok(())
}
