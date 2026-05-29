#!/usr/bin/env bash
# scripts/dev/local-up.sh — start the local Broker/Runner substrate stack.
#
# Brings up:
#   1. Local Redis (Docker container, single-port mapping)
#   2. control-plane Node process
#   3. api-gateway Node process
#   4. Broker Node process with a child-process Runner pool
#   5. placement-router Rust binary
#
# Run scripts/dev/local-down.sh to stop everything. Logs land under
# ./var/local-up/<service>.log.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$REPO_ROOT/var/local-up"
PID_DIR="$REPO_ROOT/var/local-up/pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

say()  { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
ok()   { printf "    \033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "    \033[33m!\033[0m %s\n" "$*"; }
err()  { printf "    \033[31m✗\033[0m %s\n" "$*"; exit 1; }

wait_http() {
  local label="$1"
  local url="$2"
  local log_path="$3"
  local attempts="${4:-20}"
  for i in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      ok "$label responding"
      return
    fi
    sleep 0.5
  done
  err "$label did not become ready; see $log_path"
}

# ---------------------------------------------------------------------------
# Prereqs
# ---------------------------------------------------------------------------
say "Prereq check"
command -v docker >/dev/null 2>&1 || err "docker not installed"
command -v node   >/dev/null 2>&1 || err "node not installed"
command -v pnpm   >/dev/null 2>&1 || err "pnpm not installed (npm i -g pnpm)"

ROUTER_BIN="$REPO_ROOT/.cache/router/router"
ROUTER_DIR="$REPO_ROOT/orchestration/placement-router"
if [[ ! -x "$ROUTER_BIN" ]]; then
  warn "placement-router not built; running scripts/build/build-router.sh"
  "$REPO_ROOT/scripts/build/build-router.sh"
elif find "$ROUTER_DIR/src" "$ROUTER_DIR/Cargo.toml" "$ROUTER_DIR/Cargo.lock" \
    -type f -newer "$ROUTER_BIN" | grep -q .; then
  warn "placement-router cache is stale; running scripts/build/build-router.sh"
  "$REPO_ROOT/scripts/build/build-router.sh"
fi
ok "router: $ROUTER_BIN"

if [[ ! -d "$REPO_ROOT/node_modules/.pnpm" ]]; then
  warn "node_modules missing; running pnpm install"
  (cd "$REPO_ROOT" && pnpm install)
fi
ok "pnpm install: ok"

HELLO_BUNDLE_DIST="$REPO_ROOT/examples/bundles/hello-ws-echo/dist/bundle.js"
if [[ ! -f "$HELLO_BUNDLE_DIST" || "${PAX_FORCE_BUNDLE_REBUILD:-0}" == "1" ]]; then
  warn "hello-ws-echo bundle not built; running scripts/build/build-bundles.sh"
  "$REPO_ROOT/scripts/build/build-bundles.sh"
fi
ok "creator bundles: ok"

# ---------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------
say "Redis"
if docker ps --format '{{.Names}}' | grep -q '^pax-redis$'; then
  ok "pax-redis container already running"
else
  if docker ps -a --format '{{.Names}}' | grep -q '^pax-redis$'; then
    docker rm pax-redis >/dev/null
  fi
  docker run -d --name pax-redis --rm -p 6379:6379 redis:7-alpine >/dev/null
  ok "started pax-redis (6379)"
fi
for i in $(seq 1 10); do
  if docker exec pax-redis redis-cli ping 2>/dev/null | grep -q PONG; then
    ok "redis PONG"
    break
  fi
  sleep 0.3
  if (( i == 10 )); then
    err "redis did not respond to PING"
  fi
done

# ---------------------------------------------------------------------------
# Control plane
# ---------------------------------------------------------------------------
say "control-plane"
CONTROL_LOG="$LOG_DIR/control-plane.log"
CONTROL_PIDFILE="$PID_DIR/control-plane.pid"
if [[ -f "$CONTROL_PIDFILE" ]] && kill -0 "$(cat "$CONTROL_PIDFILE")" 2>/dev/null; then
  ok "control-plane already running (pid $(cat "$CONTROL_PIDFILE"))"
else
  : > "$CONTROL_LOG"
  ( cd "$REPO_ROOT" && \
    REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}" \
    PAX_CONTROL_BIND="${PAX_CONTROL_BIND:-127.0.0.1:9070}" \
    PAX_HISTORY_PATH="${PAX_HISTORY_PATH:-$REPO_ROOT/var/history.jsonl}" \
    nohup ./node_modules/.bin/tsx orchestration/control-plane/src/app.mts \
      >"$CONTROL_LOG" 2>&1 & echo $! > "$CONTROL_PIDFILE" )
  ok "control-plane pid $(cat "$CONTROL_PIDFILE") (log: $CONTROL_LOG)"
fi
wait_http "control-plane /health" "http://127.0.0.1:9070/health" "$CONTROL_LOG"

# ---------------------------------------------------------------------------
# API gateway
# ---------------------------------------------------------------------------
say "api-gateway"
GATEWAY_LOG="$LOG_DIR/api-gateway.log"
GATEWAY_PIDFILE="$PID_DIR/api-gateway.pid"
if [[ -f "$GATEWAY_PIDFILE" ]] && kill -0 "$(cat "$GATEWAY_PIDFILE")" 2>/dev/null; then
  ok "api-gateway already running (pid $(cat "$GATEWAY_PIDFILE"))"
else
  : > "$GATEWAY_LOG"
  ( cd "$REPO_ROOT" && \
    PAX_API_GATEWAY_BIND="${PAX_API_GATEWAY_BIND:-127.0.0.1:9081}" \
    PAX_API_GATEWAY_BASE_URL="${PAX_API_GATEWAY_BASE_URL:-http://127.0.0.1:9081}" \
    PAX_API_WIRE_RECORDS_PATH="${PAX_API_WIRE_RECORDS_PATH:-$REPO_ROOT/var/api-invoke-records.jsonl}" \
    nohup ./node_modules/.bin/tsx orchestration/api-gateway/src/app.mts \
      >"$GATEWAY_LOG" 2>&1 & echo $! > "$GATEWAY_PIDFILE" )
  ok "api-gateway pid $(cat "$GATEWAY_PIDFILE") (log: $GATEWAY_LOG)"
fi
wait_http "api-gateway /health" "http://127.0.0.1:9081/health" "$GATEWAY_LOG"

# ---------------------------------------------------------------------------
# Broker + Runner pool
# ---------------------------------------------------------------------------
say "broker"
BROKER_LOG="$LOG_DIR/broker.log"
BROKER_PIDFILE="$PID_DIR/broker.pid"
if [[ -f "$BROKER_PIDFILE" ]] && kill -0 "$(cat "$BROKER_PIDFILE")" 2>/dev/null; then
  ok "broker already running (pid $(cat "$BROKER_PIDFILE"))"
else
  : > "$BROKER_LOG"
  ( cd "$REPO_ROOT" && \
    REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}" \
    PAX_JWT_SECRET="${PAX_JWT_SECRET:-local-dev-secret}" \
    PAX_API_GATEWAY_URL="${PAX_API_GATEWAY_URL:-http://127.0.0.1:9081/invoke}" \
    PAX_BROKER_BIND="${PAX_BROKER_BIND:-127.0.0.1:7700}" \
    PAX_SHARD_PUBLIC_URL="${PAX_SHARD_PUBLIC_URL:-http://127.0.0.1:7700}" \
    PAX_SHARD_ID="${PAX_SHARD_ID:-shard-local}" \
    PAX_HISTORY_PATH="${PAX_HISTORY_PATH:-$REPO_ROOT/var/history.jsonl}" \
    PAX_LOCAL_TIGRIS_DIR="${PAX_LOCAL_TIGRIS_DIR:-$REPO_ROOT/var/tigris-local}" \
    PAX_STATE_CHECKPOINT_INTERVAL_MS="${PAX_STATE_CHECKPOINT_INTERVAL_MS:-1000}" \
    PAX_STATE_RETAIN_CHECKPOINTS="${PAX_STATE_RETAIN_CHECKPOINTS:-20}" \
    PAX_RUNNER_KIND="${PAX_RUNNER_KIND:-noivm}" \
    PAX_RUNNER_PROCESS_COUNT="${PAX_RUNNER_PROCESS_COUNT:-1}" \
    PAX_WS_BANDWIDTH_BYTES_PER_SEC="${PAX_WS_BANDWIDTH_BYTES_PER_SEC:-4194304}" \
    PAX_WS_MESSAGES_PER_SEC="${PAX_WS_MESSAGES_PER_SEC:-500}" \
    PAX_RUNNER_CHILD_MODULE="${PAX_RUNNER_CHILD_MODULE:-$REPO_ROOT/runtime/runner/src/child-process.mts}" \
    PAX_RUNNER_CHILD_EXEC_ARGV="${PAX_RUNNER_CHILD_EXEC_ARGV:---import tsx}" \
    nohup ./node_modules/.bin/tsx runtime/broker/src/server.mts \
      >"$BROKER_LOG" 2>&1 & echo $! > "$BROKER_PIDFILE" )
  ok "broker pid $(cat "$BROKER_PIDFILE") (log: $BROKER_LOG)"
fi
wait_http "broker /healthz" "http://127.0.0.1:7700/healthz" "$BROKER_LOG"

say "Wait for shard registration"
for i in $(seq 1 30); do
  if docker exec pax-redis redis-cli EXISTS "shards:${PAX_SHARD_ID:-shard-local}" 2>/dev/null | grep -q '^1$'; then
    ok "shard registered: shards:${PAX_SHARD_ID:-shard-local}"
    break
  fi
  sleep 1
  if (( i == 30 )); then
    err "shard did not register in 30s; see $BROKER_LOG"
  fi
done

# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------
say "placement-router"
ROUTER_LOG="$LOG_DIR/router.log"
ROUTER_PIDFILE="$PID_DIR/router.pid"
if [[ -f "$ROUTER_PIDFILE" ]] && kill -0 "$(cat "$ROUTER_PIDFILE")" 2>/dev/null; then
  ok "router already running (pid $(cat "$ROUTER_PIDFILE"))"
else
  : > "$ROUTER_LOG"
  ( cd "$REPO_ROOT" && \
    REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}" \
    PAX_JWT_SECRET="${PAX_JWT_SECRET:-local-dev-secret}" \
    RUST_LOG="${RUST_LOG:-info}" \
    nohup "$ROUTER_BIN" \
      >"$ROUTER_LOG" 2>&1 & echo $! > "$ROUTER_PIDFILE" )
  ok "router pid $(cat "$ROUTER_PIDFILE") (log: $ROUTER_LOG)"
fi
wait_http "router /health" "http://127.0.0.1:9080/health" "$ROUTER_LOG"

say "Local stack up"
ok "redis:         redis://127.0.0.1:6379"
ok "control-plane: http://127.0.0.1:9070"
ok "api-gateway:   http://127.0.0.1:9081"
ok "broker:        http://127.0.0.1:7700 -> shards:${PAX_SHARD_ID:-shard-local}"
ok "router:        http://127.0.0.1:9080"
ok "logs:          $LOG_DIR/"
echo
echo "    Run smoke:  pnpm smoke   (or: tsx testing/smoke-bot/src/smoke.mts)"
echo "    Stop stack: ./scripts/dev/local-down.sh"
