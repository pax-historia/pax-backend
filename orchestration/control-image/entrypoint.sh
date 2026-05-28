#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/app}"
ROUTER_BINARY="${ROUTER_BINARY:-/usr/local/bin/pax-backend-placement-router}"

export NODE_ENV="${NODE_ENV:-production}"
export PAX_ENVIRONMENT="${PAX_ENVIRONMENT:-production}"
export PAX_ROUTER_BIND="${PAX_ROUTER_BIND:-0.0.0.0:9080}"
export PAX_CONTROL_BIND="${PAX_CONTROL_BIND:-0.0.0.0:9070}"
export PAX_API_GATEWAY_BIND="${PAX_API_GATEWAY_BIND:-0.0.0.0:9081}"
export PAX_ROUTER_URL="${PAX_ROUTER_URL:-http://127.0.0.1:9080}"
export PAX_CONTROL_BASE_URL="${PAX_CONTROL_BASE_URL:-http://127.0.0.1:9070}"
export PAX_API_GATEWAY_BASE_URL="${PAX_API_GATEWAY_BASE_URL:-http://127.0.0.1:9081}"
export PAX_HISTORY_PATH="${PAX_HISTORY_PATH:-/data/history/history.jsonl}"
export PAX_API_WIRE_RECORDS_PATH="${PAX_API_WIRE_RECORDS_PATH:-/data/api-invoke-records.jsonl}"
export PAX_LOCAL_ENGINE_ADMIN_TOKEN="${PAX_LOCAL_ENGINE_ADMIN_TOKEN:-dev}"

mkdir -p \
  "$(dirname "$PAX_HISTORY_PATH")" \
  "$(dirname "$PAX_API_WIRE_RECORDS_PATH")"

pids=()

start_service() {
  local name="$1"
  shift
  echo "[control-image] starting $name"
  "$@" &
  pids+=("$!")
}

terminate() {
  local signal="${1:-TERM}"
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "-$signal" "$pid" 2>/dev/null || true
    fi
  done
}

trap 'terminate TERM' TERM
trap 'terminate INT' INT

start_service "placement-router" "$ROUTER_BINARY"
start_service "control-plane" node "$APP_ROOT/node_modules/tsx/dist/cli.mjs" \
  "$APP_ROOT/orchestration/control-plane/src/app.mts"
start_service "api-gateway" node "$APP_ROOT/node_modules/tsx/dist/cli.mjs" \
  "$APP_ROOT/orchestration/api-gateway/src/app.mts"

set +e
wait -n "${pids[@]}"
status="$?"
terminate TERM
wait "${pids[@]}" 2>/dev/null
exit "$status"
