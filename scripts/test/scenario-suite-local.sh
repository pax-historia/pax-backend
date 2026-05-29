#!/usr/bin/env bash
# Run scenario-runner suite catalogs against the local stack for each Runner runtime.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUTPUT_ROOT="${PAX_SCENARIO_SUITE_OUTPUT_ROOT:-$REPO_ROOT/var/scenario-suite}"
RUNTIMES="${PAX_SCENARIO_SUITE_RUNTIMES:-ivm,noivm}"
CATALOGS="${PAX_SCENARIO_SUITE_CATALOGS:-testing/scenarios}"
SCENARIOS="${PAX_SCENARIO_SUITE_SCENARIOS:-all}"
NEMESES="${PAX_SCENARIO_SUITE_NEMESES:-all}"
ORACLES="${PAX_SCENARIO_SUITE_ORACLES:-scenario}"
PHASE_TIMEOUT_MS="${PAX_SCENARIO_SUITE_PHASE_TIMEOUT_MS:-30000}"
CONTROL_URL="${PAX_SCENARIO_SUITE_CONTROL_URL:-${PAX_CONTROL_URL:-http://127.0.0.1:9070}}"
API_GATEWAY_URL="${PAX_SCENARIO_SUITE_API_GATEWAY_URL:-${PAX_API_GATEWAY_BASE_URL:-http://127.0.0.1:9081}}"
ROUTER_URL="${PAX_SCENARIO_SUITE_ROUTER_URL:-${PAX_ROUTER_URL:-http://127.0.0.1:9080}}"

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
  PAX_RUNNER_KIND="$runtime" "$REPO_ROOT/scripts/dev/local-up.sh"
  for catalog in "${CATALOG_LIST[@]}"; do
    catalog="$(printf '%s' "$catalog" | xargs)"
    if [[ -z "$catalog" ]]; then
      continue
    fi
    catalog_name="$(printf '%s' "$catalog" | sed -E 's#^\./##; s#[^A-Za-z0-9._-]+#-#g; s#^-+|-+$##g')"
    output_dir="$OUTPUT_ROOT/$runtime/$catalog_name"
    pnpm exec tsx testing/scenario-runner/src/cli.mts \
      --suite "$catalog" \
      --runtime "$runtime" \
      --scenarios "$SCENARIOS" \
      --nemeses "$NEMESES" \
      --oracles "$ORACLES" \
      --control-url "$CONTROL_URL" \
      --api-gateway-url "$API_GATEWAY_URL" \
      --router-url "$ROUTER_URL" \
      --output-dir "$output_dir" \
      --output "$output_dir/suite.cli.json" \
      --phase-timeout-ms "$PHASE_TIMEOUT_MS"
  done
done
