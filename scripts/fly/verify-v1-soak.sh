#!/usr/bin/env bash
set -euo pipefail

# Verify a pulled Phase 5 v1 soak artifact directory against the exit-soak gates.
#
# Usage:
#   scripts/fly/verify-v1-soak.sh var/phase-5/soak/ivm-20260528T222045Z
#   PAX_SOAK_RUNTIME=noivm scripts/fly/verify-v1-soak.sh var/phase-5/soak/noivm-...

SOAK_DIR="${1:-}"
OUTPUT_PATH="${2:-}"
RUNTIME="${PAX_SOAK_RUNTIME:-ivm}"
RUNG_ID="${PAX_SOAK_RUNG_ID:-1000g-10shards-24h-suite}"
SCENARIO_ID="${PAX_SOAK_SCENARIO_ID:-chat-steady-state}"

err() {
  printf "error: %s\n" "$*" >&2
  exit 2
}

[[ -n "$SOAK_DIR" ]] || err "missing soak artifact directory"
[[ "$RUNTIME" == "ivm" || "$RUNTIME" == "noivm" ]] || err "PAX_SOAK_RUNTIME must be ivm or noivm"
if [[ -z "$OUTPUT_PATH" ]]; then
  OUTPUT_PATH="$SOAK_DIR/soak-summary.final.json"
fi

case_prefix="${RUNTIME}-${SCENARIO_ID}-${RUNG_ID}"
expected_case_ids="${case_prefix}-no-faults,${case_prefix}-shard-death-every-5m,${case_prefix}-api-kind-partition-burst"
expected_phases="seed-fixtures,open-sessions,send-json,close-sessions,expect-history-events"

pnpm exec tsx scripts/fly/summarize-soak.mts \
  --soak-dir "$SOAK_DIR" \
  --output "$OUTPUT_PATH" \
  --expect-cases 3 \
  --expect-case-ids "$expected_case_ids" \
  --expect-target-games 1000 \
  --expect-placement-shards 10 \
  --expect-completed-phases "$expected_phases" \
  --expect-exit-code 0 \
  --require-results
