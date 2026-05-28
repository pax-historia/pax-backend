#!/usr/bin/env bash
# scripts/dev/local-up.sh — start the full local substrate stack on this Mac.
#
# Brings up:
#   1. Local Redis (Docker container, single-port mapping)
#   2. rivet-engine (cached binary from scripts/build/build-engine.sh)
#   3. control-plane Node process
#   4. api-gateway Node process
#   5. parent-actor Node process
#   6. placement-router Rust binary
#
# Run scripts/dev/local-down.sh to stop everything (kills processes,
# removes Redis container). Logs land under ./var/local-up/<service>.log.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$REPO_ROOT/var/local-up"
PID_DIR="$REPO_ROOT/var/local-up/pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

say()  { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
ok()   { printf "    \033[32m✓\033[0m %s\n" "$*"; }
warn() { printf "    \033[33m!\033[0m %s\n" "$*"; }
err()  { printf "    \033[31m✗\033[0m %s\n" "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Prereqs
# ---------------------------------------------------------------------------
say "Prereq check"
command -v docker >/dev/null 2>&1 || err "docker not installed"
command -v node   >/dev/null 2>&1 || err "node not installed"
command -v pnpm   >/dev/null 2>&1 || err "pnpm not installed (npm i -g pnpm)"

# Engine binary present?
ENGINE_BIN="$REPO_ROOT/.cache/rivet-engine/rivet-engine"
if [[ ! -x "$ENGINE_BIN" ]]; then
  err "rivet-engine not built. Run: ./scripts/build/build-engine.sh"
fi
ok "rivet-engine: $(readlink "$ENGINE_BIN" 2>/dev/null || echo "$ENGINE_BIN")"

# Router binary present?
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

# Node deps installed?
if [[ ! -d "$REPO_ROOT/node_modules/.pnpm/isolated-vm@5.0.4" ]]; then
  warn "node_modules incomplete; running pnpm install"
  (cd "$REPO_ROOT" && pnpm install)
fi
ok "pnpm install: ok"

# Vendor TS dist built? (engine-runner + protocol + virtual-websocket)
VWS_DIST="$REPO_ROOT/vendor/rivet/shared/typescript/virtual-websocket/dist/mod.js"
ER_DIST="$REPO_ROOT/vendor/rivet/rivetkit-typescript/packages/engine-runner/dist/mod.js"
ERP_DIST="$REPO_ROOT/vendor/rivet/rivetkit-typescript/packages/engine-runner-protocol/dist/index.js"
if [[ ! -f "$VWS_DIST" || ! -f "$ER_DIST" || ! -f "$ERP_DIST" ]]; then
  warn "vendor rivetkit TS dist missing; running scripts/build/build-vendor-ts.sh"
  "$REPO_ROOT/scripts/build/build-vendor-ts.sh"
fi
ok "vendor rivetkit TS dist: ok"

# Creator bundles built? (hello-ws-echo → dist/bundle.js)
HELLO_BUNDLE_DIST="$REPO_ROOT/examples/bundles/hello-ws-echo/dist/bundle.js"
if [[ ! -f "$HELLO_BUNDLE_DIST" || "${PAX_FORCE_BUNDLE_REBUILD:-0}" == "1" ]]; then
  warn "hello-ws-echo bundle not built; running scripts/build/build-bundles.sh"
  "$REPO_ROOT/scripts/build/build-bundles.sh"
fi
ok "creator bundles: ok"

# ---------------------------------------------------------------------------
# Redis (Docker)
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
# Wait for ping
for i in 1 2 3 4 5 6 7 8 9 10; do
  if docker exec pax-redis redis-cli ping 2>/dev/null | grep -q PONG; then
    ok "redis PONG"
    break
  fi
  sleep 0.3
done

# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------
say "rivet-engine"
ENGINE_LOG="$LOG_DIR/engine.log"
ENGINE_PIDFILE="$PID_DIR/engine.pid"
if [[ -f "$ENGINE_PIDFILE" ]] && kill -0 "$(cat "$ENGINE_PIDFILE")" 2>/dev/null; then
  ok "engine already running (pid $(cat "$ENGINE_PIDFILE"))"
else
  : > "$ENGINE_LOG"
  ( cd "$REPO_ROOT" && \
    ENGINE_BINARY="$ENGINE_BIN" \
    RIVET_ADMIN_TOKEN="${RIVET_ADMIN_TOKEN:-dev}" \
    nohup ./node_modules/.bin/tsx scripts/dev/spawn-engine.mts \
      >"$ENGINE_LOG" 2>&1 & echo $! > "$ENGINE_PIDFILE" )
  ok "engine pid $(cat "$ENGINE_PIDFILE") (log: $ENGINE_LOG)"
fi

# Wait for engine HTTP ready
say "Wait for engine HTTP"
for i in $(seq 1 90); do
  if curl -fsS -H "authorization: Bearer dev" \
       "http://127.0.0.1:6420/datacenters" >/dev/null 2>&1; then
    ok "engine /datacenters responding"
    break
  fi
  sleep 1
  if (( i == 90 )); then
    err "engine did not become ready in 90s; see $ENGINE_LOG"
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
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:9070/health >/dev/null 2>&1; then
    ok "control-plane /health responding"
    break
  fi
  sleep 0.5
  if (( i == 20 )); then
    err "control-plane did not become ready in 10s; see $CONTROL_LOG"
  fi
done

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
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:9081/health >/dev/null 2>&1; then
    ok "api-gateway /health responding"
    break
  fi
  sleep 0.5
  if (( i == 20 )); then
    err "api-gateway did not become ready in 10s; see $GATEWAY_LOG"
  fi
done

# ---------------------------------------------------------------------------
# Parent actor
# ---------------------------------------------------------------------------
say "parent-actor"
PARENT_LOG="$LOG_DIR/parent.log"
PARENT_PIDFILE="$PID_DIR/parent.pid"
if [[ -f "$PARENT_PIDFILE" ]] && kill -0 "$(cat "$PARENT_PIDFILE")" 2>/dev/null; then
  ok "parent already running (pid $(cat "$PARENT_PIDFILE"))"
else
  : > "$PARENT_LOG"
  ( cd "$REPO_ROOT" && \
    REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}" \
    PAX_JWT_SECRET="${PAX_JWT_SECRET:-local-dev-secret}" \
    PAX_API_GATEWAY_URL="${PAX_API_GATEWAY_URL:-http://127.0.0.1:9081/invoke}" \
    PAX_SHARD_ID="${PAX_SHARD_ID:-shard-local}" \
    PAX_LOCAL_ENGINE_ADMIN_TOKEN="${RIVET_ADMIN_TOKEN:-dev}" \
    RIVET_ADMIN_TOKEN="${RIVET_ADMIN_TOKEN:-dev}" \
    nohup ./node_modules/.bin/tsx runtime/parent-actor/src/parent.mts \
      >"$PARENT_LOG" 2>&1 & echo $! > "$PARENT_PIDFILE" )
  ok "parent pid $(cat "$PARENT_PIDFILE") (log: $PARENT_LOG)"
fi

# Wait for parent ready (registered in Redis)
say "Wait for shard registration"
for i in $(seq 1 30); do
  if docker exec pax-redis redis-cli EXISTS "shards:${PAX_SHARD_ID:-shard-local}" 2>/dev/null | grep -q '^1$'; then
    ok "shard registered: shards:${PAX_SHARD_ID:-shard-local}"
    break
  fi
  sleep 1
  if (( i == 30 )); then
    err "shard did not register in 30s; see $PARENT_LOG"
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
    PAX_LOCAL_ENGINE_ADMIN_TOKEN="${RIVET_ADMIN_TOKEN:-dev}" \
    RUST_LOG="${RUST_LOG:-info}" \
    nohup "$ROUTER_BIN" \
      >"$ROUTER_LOG" 2>&1 & echo $! > "$ROUTER_PIDFILE" )
  ok "router pid $(cat "$ROUTER_PIDFILE") (log: $ROUTER_LOG)"
fi
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:9080/health >/dev/null 2>&1; then
    ok "router /health responding"
    break
  fi
  sleep 0.5
  if (( i == 20 )); then
    err "router did not become ready in 10s; see $ROUTER_LOG"
  fi
done

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
say "Local stack up"
ok "redis:         redis://127.0.0.1:6379"
ok "engine:        http://127.0.0.1:6420 (admin token: ${RIVET_ADMIN_TOKEN:-dev})"
ok "control-plane: http://127.0.0.1:9070"
ok "api-gateway:   http://127.0.0.1:9081"
ok "parent-actor:  pid $(cat "$PARENT_PIDFILE") -> shards:${PAX_SHARD_ID:-shard-local}"
ok "router:        http://127.0.0.1:9080"
ok "logs:          $LOG_DIR/"
echo
echo "    Run smoke:  pnpm smoke   (or: tsx testing/smoke-bot/src/smoke.mts)"
echo "    Stop stack: ./scripts/dev/local-down.sh"
