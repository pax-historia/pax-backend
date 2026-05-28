#!/usr/bin/env bash
# scripts/build/build-router.sh — native macOS build of the placement router.
#
# Small crate (~10 deps); cold build is a couple of minutes, incremental is
# seconds. Builds in release mode — pax-sharded-spike scratchpad 2026-05-27
# caught a debug-build router saturating at 10k/50k games in 5 min ramp.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROUTER_DIR="$REPO_ROOT/orchestration/placement-router"
CACHE_DIR="$REPO_ROOT/.cache/router"
# Pin target dir into the workspace so sandboxes / non-sandboxed runs agree
# on where the binary lands. Also prevents Cursor's sandbox-cache target
# redirect from hiding the output under /var/folders/.
TARGET_DIR="$ROUTER_DIR/target"

mkdir -p "$CACHE_DIR"

cd "$ROUTER_DIR"
echo "[build-router] cargo build --release (target=$TARGET_DIR)"
START_TS=$(date +%s)
CARGO_TARGET_DIR="$TARGET_DIR" cargo build --release 2>&1
END_TS=$(date +%s)
echo "[build-router] build wall-clock: $((END_TS - START_TS))s"

SRC_BIN="$TARGET_DIR/release/pax-backend-placement-router"
if [[ ! -x "$SRC_BIN" ]]; then
  echo "[build-router] ERROR: binary not found at $SRC_BIN"
  echo "[build-router] target tree contents:"
  find "$TARGET_DIR" -maxdepth 3 -type f -name 'pax-backend-placement-router' 2>/dev/null || true
  exit 1
fi
cp "$SRC_BIN" "$CACHE_DIR/router"
echo "[build-router] cached: $CACHE_DIR/router"
