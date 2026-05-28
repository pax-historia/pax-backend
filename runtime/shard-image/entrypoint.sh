#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/app}"
ENGINE_BINARY="${ENGINE_BINARY:-/usr/local/bin/rivet-engine}"
PAX_ENGINE_DATA_DIR="${PAX_ENGINE_DATA_DIR:-/data/rivet-engine}"
PAX_ENGINE_CONFIG="${PAX_ENGINE_CONFIG:-$PAX_ENGINE_DATA_DIR/rivet-engine.config.json}"
PAX_ENGINE_DB_DIR="${PAX_ENGINE_DB_DIR:-$PAX_ENGINE_DATA_DIR/db}"

export RIVET_ADMIN_TOKEN="${RIVET_ADMIN_TOKEN:-${PAX_LOCAL_ENGINE_ADMIN_TOKEN:-dev}}"
export RIVET_ENGINE_ENDPOINT="${RIVET_ENGINE_ENDPOINT:-http://127.0.0.1:6420}"
export PAX_SHARD_PUBLIC_URL="${PAX_SHARD_PUBLIC_URL:-http://127.0.0.1:6420}"
export PAX_PARENT_METRICS_BIND="${PAX_PARENT_METRICS_BIND:-0.0.0.0:7700}"
export PAX_HISTORY_PATH="${PAX_HISTORY_PATH:-/data/history/history.jsonl}"
export PAX_BUNDLE_CACHE_DIR="${PAX_BUNDLE_CACHE_DIR:-/data/bundle-cache}"
export PAX_LOCAL_TIGRIS_DIR="${PAX_LOCAL_TIGRIS_DIR:-/data/tigris-local}"
export PAX_SERVICE_NAME="${PAX_SERVICE_NAME:-pax-backend-shards}"
export PAX_ZONE="${PAX_ZONE:-runtime}"
export VECTOR_DATA_DIR="${VECTOR_DATA_DIR:-/data/vector}"
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://127.0.0.1:4317}"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:-$OTEL_EXPORTER_OTLP_ENDPOINT}"
export PAX_OTEL_EXPORTER_OTLP_ENDPOINT="${PAX_OTEL_EXPORTER_OTLP_ENDPOINT:-$OTEL_EXPORTER_OTLP_ENDPOINT}"
if [[ "${PAX_OBSERVABILITY:-on}" == "off" ]]; then
  export RIVET_OTEL_ENABLED="${RIVET_OTEL_ENABLED:-0}"
else
  export RIVET_OTEL_ENABLED="${RIVET_OTEL_ENABLED:-1}"
fi
export RIVET_OTEL_GRPC_ENDPOINT="${RIVET_OTEL_GRPC_ENDPOINT:-${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:-${OTEL_EXPORTER_OTLP_ENDPOINT:-http://127.0.0.1:4317}}}"
export RIVET_OTEL_SAMPLER_RATIO="${RIVET_OTEL_SAMPLER_RATIO:-1}"
export RUST_TRACE="${RUST_TRACE:-info}"

mkdir -p \
  "$(dirname "$PAX_ENGINE_CONFIG")" \
  "$PAX_ENGINE_DB_DIR" \
  "$(dirname "$PAX_HISTORY_PATH")" \
  "$PAX_BUNDLE_CACHE_DIR" \
  "$PAX_LOCAL_TIGRIS_DIR" \
  "$VECTOR_DATA_DIR" \
  "${PAX_VECTOR_BUFFER_DIR:-/data/observability}"

PAX_ENGINE_CONFIG="$PAX_ENGINE_CONFIG" \
PAX_ENGINE_DB_DIR="$PAX_ENGINE_DB_DIR" \
node <<'NODE'
const fs = require("node:fs");

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function csvEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw.split(",").map((v) => v.trim()).filter(Boolean);
  return values.length > 0 ? values : fallback;
}

const config = {
  auth: { admin_token: process.env.RIVET_ADMIN_TOKEN ?? "dev" },
  guard: {
    host: process.env.RIVET_GUARD_HOST ?? "0.0.0.0",
    port: intEnv("RIVET_GUARD_PORT", 6420),
    tcp_nodelay: true,
    enable_websocket_health_route: true,
    actor_ready_timeout_ms: intEnv("RIVET_ACTOR_READY_TIMEOUT_MS", 30000),
    route_timeout_ms: intEnv("RIVET_ROUTE_TIMEOUT_MS", 30000),
  },
  api_peer: {
    host: process.env.RIVET_API_PEER_HOST ?? "0.0.0.0",
    port: intEnv("RIVET_API_PEER_PORT", 6421),
  },
  metrics: {
    host: process.env.RIVET_METRICS_HOST ?? "0.0.0.0",
    port: intEnv("RIVET_METRICS_PORT", 6430),
  },
  topology: {
    datacenter_label: 1,
    datacenters: {
      default: {
        datacenter_label: 1,
        is_leader: true,
        peer_url: process.env.RIVET_PEER_URL ?? "http://127.0.0.1:6421",
        public_url:
          process.env.RIVET_PUBLIC_URL ??
          process.env.PAX_SHARD_PUBLIC_URL ??
          "http://127.0.0.1:6420",
        valid_hosts: csvEnv("RIVET_VALID_HOSTS", ["127.0.0.1", "localhost"]),
      },
    },
  },
  file_system: { path: process.env.PAX_ENGINE_DB_DIR },
  cache: { enabled: true, driver: "in_memory" },
  telemetry: { enabled: false },
  runtime: {
    allow_version_rollback: true,
    guard_shutdown_duration: intEnv("RIVET_GUARD_SHUTDOWN_DURATION_SEC", 30),
    force_shutdown_duration: intEnv("RIVET_FORCE_SHUTDOWN_DURATION_SEC", 60),
  },
};

fs.writeFileSync(process.env.PAX_ENGINE_CONFIG, JSON.stringify(config, null, 2));
NODE

terminate() {
  local signal="${1:-TERM}"
  if [[ -n "${parent_pid:-}" ]] && kill -0 "$parent_pid" 2>/dev/null; then
    kill "-$signal" "$parent_pid" 2>/dev/null || true
  fi
  if [[ -n "${engine_pid:-}" ]] && kill -0 "$engine_pid" 2>/dev/null; then
    kill "-$signal" "$engine_pid" 2>/dev/null || true
  fi
  if [[ -n "${vector_pid:-}" ]] && kill -0 "$vector_pid" 2>/dev/null; then
    kill "-$signal" "$vector_pid" 2>/dev/null || true
  fi
}

trap 'terminate TERM' TERM
trap 'terminate INT' INT

if [[ "${PAX_OBSERVABILITY:-on}" != "off" ]]; then
  "$APP_ROOT/scripts/observability/start-vector.sh" &
  vector_pid="$!"
fi

echo "[shard-image] engine config: $PAX_ENGINE_CONFIG"
"$ENGINE_BINARY" --config "$PAX_ENGINE_CONFIG" start &
engine_pid="$!"

node "$APP_ROOT/node_modules/tsx/dist/cli.mjs" \
  "$APP_ROOT/runtime/parent-actor/src/parent.mts" &
parent_pid="$!"

set +e
if [[ -n "${vector_pid:-}" ]]; then
  wait -n "$engine_pid" "$parent_pid" "$vector_pid"
else
  wait -n "$engine_pid" "$parent_pid"
fi
status="$?"
terminate TERM
if [[ -n "${vector_pid:-}" ]]; then
  wait "$engine_pid" "$parent_pid" "$vector_pid" 2>/dev/null
else
  wait "$engine_pid" "$parent_pid" 2>/dev/null
fi
exit "$status"
