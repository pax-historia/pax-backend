#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/app}"

export PAX_BROKER_BIND="${PAX_BROKER_BIND:-0.0.0.0:7700}"
export PAX_BROKER_WS_PATH="${PAX_BROKER_WS_PATH:-/gateway}"
export PAX_SHARD_PUBLIC_URL="${PAX_SHARD_PUBLIC_URL:-http://127.0.0.1:7700}"
export PAX_HISTORY_PATH="${PAX_HISTORY_PATH:-/data/history/history.jsonl}"
export PAX_LOCAL_TIGRIS_DIR="${PAX_LOCAL_TIGRIS_DIR:-/data/tigris-local}"
export PAX_BUNDLE_CACHE_DIR="${PAX_BUNDLE_CACHE_DIR:-/data/bundle-cache}"
export PAX_SERVICE_NAME="${PAX_SERVICE_NAME:-pax-broker}"
export PAX_ZONE="${PAX_ZONE:-runtime}"
export VECTOR_DATA_DIR="${VECTOR_DATA_DIR:-/data/vector}"
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://127.0.0.1:4317}"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:-$OTEL_EXPORTER_OTLP_ENDPOINT}"
export PAX_OTEL_EXPORTER_OTLP_ENDPOINT="${PAX_OTEL_EXPORTER_OTLP_ENDPOINT:-$OTEL_EXPORTER_OTLP_ENDPOINT}"
export PAX_RUNNER_CHILD_EXEC_ARGV="${PAX_RUNNER_CHILD_EXEC_ARGV:---import tsx}"

mkdir -p \
  "$(dirname "$PAX_HISTORY_PATH")" \
  "$PAX_BUNDLE_CACHE_DIR" \
  "$PAX_LOCAL_TIGRIS_DIR" \
  "$VECTOR_DATA_DIR" \
  "${PAX_VECTOR_BUFFER_DIR:-/data/observability}"

terminate() {
  local signal="${1:-TERM}"
  if [[ -n "${broker_pid:-}" ]] && kill -0 "$broker_pid" 2>/dev/null; then
    kill "-$signal" "$broker_pid" 2>/dev/null || true
  fi
  if [[ -n "${vector_pid:-}" ]] && kill -0 "$vector_pid" 2>/dev/null; then
    kill "-$signal" "$vector_pid" 2>/dev/null || true
  fi
}

trap 'terminate TERM' TERM
trap 'terminate INT' INT

if [[ "${PAX_OBSERVABILITY:-on}" != "off" ]]; then
  "$APP_ROOT/scripts/observability/start-vector.sh" &
  vector_pid="$!"
fi

echo "[shard-image] broker bind: $PAX_BROKER_BIND"
node "$APP_ROOT/node_modules/tsx/dist/cli.mjs" \
  "$APP_ROOT/runtime/broker/src/server.mts" &
broker_pid="$!"

set +e
if [[ -n "${vector_pid:-}" ]]; then
  wait -n "$broker_pid" "$vector_pid"
else
  wait -n "$broker_pid"
fi
status="$?"
terminate TERM
if [[ -n "${vector_pid:-}" ]]; then
  wait "$broker_pid" "$vector_pid" 2>/dev/null
else
  wait "$broker_pid" 2>/dev/null
fi
exit "$status"
