#!/usr/bin/env bash
# scripts/build-bundles.sh — bundle creator code to ivm-loadable script.
#
# Usage:
#   ./scripts/build-bundles.sh            # build every tooling/bundles/* with a src/index.mts
#   ./scripts/build-bundles.sh hello-ws-echo  # build just one
#
# Each bundle's TypeScript source is esbuild-bundled as an IIFE with the
# default export attached to a known global, then a footer calls
# __pax_install(globalThis.__pax_bundle_module.default). isolated-vm can
# eval the result directly.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLES_DIR="$REPO_ROOT/tooling/bundles"
ESBUILD="$REPO_ROOT/node_modules/.bin/esbuild"

if [[ ! -x "$ESBUILD" ]]; then
  echo "[build-bundles] esbuild not installed; run pnpm install"
  exit 1
fi

build_one() {
  local name="$1"
  local pkg_dir="$BUNDLES_DIR/$name"
  local src="$pkg_dir/src/index.mts"
  local out="$pkg_dir/dist/bundle.js"
  if [[ ! -f "$src" ]]; then
    echo "[build-bundles] skip $name (no src/index.mts)"
    return 0
  fi
  mkdir -p "$pkg_dir/dist"
  echo "[build-bundles] bundling $name"
  "$ESBUILD" "$src" \
    --bundle \
    --format=iife \
    --target=es2022 \
    --platform=neutral \
    --global-name=__pax_bundle_module \
    --footer:js="__pax_install(__pax_bundle_module.default);" \
    --outfile="$out"
  echo "[build-bundles]   -> $out"
}

if [[ $# -eq 0 ]]; then
  for d in "$BUNDLES_DIR"/*/; do
    name="$(basename "$d")"
    build_one "$name"
  done
else
  for name in "$@"; do
    build_one "$name"
  done
fi
