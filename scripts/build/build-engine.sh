#!/usr/bin/env bash
# scripts/build/build-engine.sh
#
# Native macOS build of rivet-engine, cached by vendor/rivet pin SHA so the
# build is a no-op when nothing's changed.
#
# Profile: `quick` — codegen-units=256, opt-level=1, panic=abort. Drops debug
# info and unwinding for a fast link, keeps cheap optimizations. Defined in
# vendor/rivet/Cargo.toml at the workspace level (we did not invent it).
#
# Why native: pax-rocks-spike measured cold local Docker (linux/amd64 via
# Rosetta) at >20 min to 43 min for the same engine build. Native Apple
# Silicon cargo skips the cross-compile entirely. See docs/dev/dev-loop.md
# for the build-time evidence trail.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vendor/rivet"
CACHE_DIR="$REPO_ROOT/.cache/rivet-engine"

# Cache key: hash the vendor/rivet pin (UPSTREAM.md SHA + Cargo.lock for
# safety against partial mutations). If we ever wanted to invalidate by full
# tree, we could `find vendor/rivet -type f -exec shasum`; for now the
# UPSTREAM-recorded SHA is canonical because we vendor at a single commit.
PIN_SHA="$(awk -F'`' '/\*\*Source commit\*\*/ { print $2; exit }' "$VENDOR_DIR/UPSTREAM.md" 2>/dev/null || echo "unknown")"
LOCK_SHA="$(shasum "$VENDOR_DIR/Cargo.lock" 2>/dev/null | awk '{print $1}' | cut -c1-10 || echo "nolock")"
CACHE_KEY="${PIN_SHA:0:10}-${LOCK_SHA}"
CACHED_BIN="$CACHE_DIR/rivet-engine-${CACHE_KEY}"
SYMLINK="$CACHE_DIR/rivet-engine"

mkdir -p "$CACHE_DIR"

if [[ -x "$CACHED_BIN" && "${PAX_FORCE_REBUILD:-0}" != "1" ]]; then
  echo "[build-engine] cache hit: $CACHED_BIN"
  ln -sf "rivet-engine-${CACHE_KEY}" "$SYMLINK"
  echo "[build-engine] $SYMLINK -> rivet-engine-${CACHE_KEY}"
  exit 0
fi

echo "[build-engine] cache miss (key=$CACHE_KEY)"
echo "[build-engine] building rivet-engine with profile=quick (native, this Mac)..."
echo "[build-engine] vendor/rivet pin: $PIN_SHA"

cd "$VENDOR_DIR"

# Workspace-level .cargo/config.toml already sets `rustflags = ["--cfg",
# "tokio_unstable"]` — without it, rivet-runtime won't build (pax-rivet-refactor
# scratchpad 4104).
START_TS=$(date +%s)
cargo build -p rivet-engine --bin rivet-engine --profile=quick 2>&1
END_TS=$(date +%s)
echo "[build-engine] build wall-clock: $((END_TS - START_TS))s"

SRC_BIN="$VENDOR_DIR/target/quick/rivet-engine"
if [[ ! -x "$SRC_BIN" ]]; then
  echo "[build-engine] ERROR: build succeeded but binary not found at $SRC_BIN"
  exit 1
fi

cp "$SRC_BIN" "$CACHED_BIN"
ln -sf "rivet-engine-${CACHE_KEY}" "$SYMLINK"
echo "[build-engine] cached: $CACHED_BIN"
echo "[build-engine] $SYMLINK -> rivet-engine-${CACHE_KEY}"
