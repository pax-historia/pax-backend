#!/usr/bin/env bash
# scripts/dev/local-down.sh — stop everything scripts/dev/local-up.sh
# started. Kills tracked pidfiles, then sweeps strays by command match.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PID_DIR="$REPO_ROOT/var/local-up/pids"

say()  { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
ok()   { printf "    \033[32m✓\033[0m %s\n" "$*"; }
skip() { printf "    \033[33m·\033[0m %s\n" "$*"; }

stop_pid() {
  local name="$1"
  local pidfile="$2"
  if [[ -f "$pidfile" ]]; then
    local pid
    pid="$(cat "$pidfile" 2>/dev/null || echo "")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      for i in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.4
      done
      kill -KILL "$pid" 2>/dev/null || true
      ok "$name stopped (pid $pid)"
    else
      skip "$name pidfile exists but process gone"
    fi
    rm -f "$pidfile"
  else
    skip "$name not running"
  fi
}

say "Stopping local stack"
stop_pid "router" "$PID_DIR/router.pid"
stop_pid "parent" "$PID_DIR/parent.pid"
stop_pid "engine" "$PID_DIR/engine.pid"

# Belt-and-suspenders: kill any stray processes whose command line matches
# our entry points (an earlier run may have lost its pidfile across script
# changes / sandbox restarts).
say "Sweeping stray processes by command"
sweep() {
  local pattern="$1"
  local label="$2"
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    skip "no stray $label"
    return
  fi
  for pid in $pids; do
    # Don't kill the current shell or its parents
    if [[ "$pid" == "$$" || "$pid" == "$PPID" ]]; then continue; fi
    if kill -TERM "$pid" 2>/dev/null; then
      ok "TERM stray $label pid $pid"
    fi
  done
}
sweep "runtime/parent-actor/src/parent"        "parent"
sweep "scripts/dev/spawn-engine.mts"           "engine spawner"
sweep "scripts/spawn-engine.mts"               "engine spawner (legacy)"
sweep ".cache/rivet-engine/rivet-engine"       "rivet-engine"
sweep ".cache/router/router"                   "router"
sleep 1
sweep "runtime/parent-actor/src/parent"        "parent (kill)"
sweep ".cache/rivet-engine/rivet-engine"       "rivet-engine (kill)"

if docker ps --format '{{.Names}}' | grep -q '^pax-redis$'; then
  docker stop pax-redis >/dev/null 2>&1 || true
  ok "pax-redis stopped"
else
  skip "pax-redis not running"
fi

say "Done"
