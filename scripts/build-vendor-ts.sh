#!/usr/bin/env bash
# scripts/build-vendor-ts.sh — build the three RivetKit TS packages our
# parent-actor depends on, into their in-vendor dist/ directories.
#
# These dist files are build artifacts (gitignored in upstream Rivet), so
# `git archive` of vendor/rivet does not bring them along. We build them once
# from source here.
#
# Scope: only @rivetkit/{engine-runner-protocol, virtual-websocket,
# engine-runner}. Skips the rest of the upstream pnpm workspace (frontend,
# tests, examples, SDKs we don't ship).
#
# Idempotent: skips if all three dist directories already exist and have
# their mod.js.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_TS="$REPO_ROOT/vendor/rivet/rivetkit-typescript/packages"
SHARED_TS="$REPO_ROOT/vendor/rivet/shared/typescript"

# package_path → expected dist entry filename (per each package.json's exports)
PKGS=(
  "$SHARED_TS/virtual-websocket:mod.js"
  "$VENDOR_TS/engine-runner-protocol:index.js"
  "$VENDOR_TS/engine-runner:mod.js"
)

all_built=1
for spec in "${PKGS[@]}"; do
  p="${spec%%:*}"
  entry="${spec##*:}"
  if [[ ! -f "$p/dist/$entry" ]]; then
    all_built=0
    break
  fi
done

if [[ "$all_built" == "1" && "${PAX_FORCE_VENDOR_TS_REBUILD:-0}" != "1" ]]; then
  echo "[vendor-ts] all three dist/ outputs already present, skipping build"
  exit 0
fi

echo "[vendor-ts] installing vendor/rivet workspace deps (one-time, filtered)..."
cd "$REPO_ROOT/vendor/rivet"

# Install just enough for the three packages we want to build. The filter
# syntax pulls transitive deps via the pnpm workspace.
pnpm install \
  --filter '@rivetkit/engine-runner...' \
  --filter '@rivetkit/virtual-websocket...' \
  --ignore-scripts \
  2>&1 | tail -10

echo "[vendor-ts] building @rivetkit/virtual-websocket"
pnpm --filter '@rivetkit/virtual-websocket' run build 2>&1 | tail -10
echo "[vendor-ts] building @rivetkit/engine-runner-protocol"
pnpm --filter '@rivetkit/engine-runner-protocol' run build 2>&1 | tail -10
echo "[vendor-ts] building @rivetkit/engine-runner"
pnpm --filter '@rivetkit/engine-runner' run build 2>&1 | tail -10

for spec in "${PKGS[@]}"; do
  p="${spec%%:*}"
  entry="${spec##*:}"
  if [[ ! -f "$p/dist/$entry" ]]; then
    echo "[vendor-ts] ERROR: $p/dist/$entry still missing after build"
    exit 1
  fi
done
echo "[vendor-ts] done"
