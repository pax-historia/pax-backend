#!/usr/bin/env bash
# Run scenario-runner suite catalogs against the local stack for each child runtime.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_ROOT="${PAX_SCENARIO_SUITE_OUTPUT_ROOT:-$REPO_ROOT/var/scenario-suite}"
RUNTIMES="${PAX_SCENARIO_SUITE_RUNTIMES:-ivm,noivm}"
CATALOGS="${PAX_SCENARIO_SUITE_CATALOGS:-testing/scenarios}"
NEMESES="${PAX_SCENARIO_SUITE_NEMESES:-all}"
PHASE_TIMEOUT_MS="${PAX_SCENARIO_SUITE_PHASE_TIMEOUT_MS:-30000}"

cd "$REPO_ROOT"

cleanup() {
  "$REPO_ROOT/scripts/dev/local-down.sh" >/dev/null 2>&1 || true
}

trap cleanup EXIT

IFS=',' read -r -a RUNTIME_LIST <<< "$RUNTIMES"
IFS=',' read -r -a CATALOG_LIST <<< "$CATALOGS"

mkdir -p "$OUTPUT_ROOT"

for runtime in "${RUNTIME_LIST[@]}"; do
  runtime="$(printf '%s' "$runtime" | xargs)"
  if [[ -z "$runtime" ]]; then
    continue
  fi
  cleanup
  PAX_CHILD_RUNNER_KIND="$runtime" "$REPO_ROOT/scripts/dev/local-up.sh"
  for catalog in "${CATALOG_LIST[@]}"; do
    catalog="$(printf '%s' "$catalog" | xargs)"
    if [[ -z "$catalog" ]]; then
      continue
    fi
    catalog_name="$(basename "$catalog")"
    output_dir="$OUTPUT_ROOT/$runtime/$catalog_name"
    pnpm exec tsx testing/scenario-runner/src/cli.mts \
      --suite "$catalog" \
      --runtime "$runtime" \
      --nemeses "$NEMESES" \
      --output-dir "$output_dir" \
      --output "$output_dir/suite.cli.json" \
      --phase-timeout-ms "$PHASE_TIMEOUT_MS"
  done
done
