#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/app}"
mode="${PAX_OBSERVABILITY:-on}"

case "$mode" in
  off)
    exit 0
    ;;
  on)
    export VECTOR_REQUIRE_HEALTHY="${VECTOR_REQUIRE_HEALTHY:-true}"
    if [[ -n "${PAX_VECTOR_CONFIG:-}" ]]; then
      config_args=(--config "$PAX_VECTOR_CONFIG")
    elif [[ -n "${PAX_VECTOR_PROFILE:-}" ]] \
      && [[ -f "$APP_ROOT/scripts/observability/vector-prod-base.toml" ]] \
      && [[ -f "$APP_ROOT/scripts/observability/vector-prod-$PAX_VECTOR_PROFILE.toml" ]]; then
      config_args=(
        --config "$APP_ROOT/scripts/observability/vector-prod-base.toml"
        --config "$APP_ROOT/scripts/observability/vector-prod-$PAX_VECTOR_PROFILE.toml"
      )
    else
      config_args=(--config "$APP_ROOT/scripts/observability/vector-prod.toml")
    fi
    ;;
  buffer)
    export VECTOR_REQUIRE_HEALTHY="${VECTOR_REQUIRE_HEALTHY:-false}"
    config_args=(--config "${PAX_VECTOR_CONFIG:-$APP_ROOT/scripts/observability/vector-local-dev.toml}")
    ;;
  *)
    echo "[observability] invalid PAX_OBSERVABILITY=$mode; expected off, buffer, or on" >&2
    exit 64
    ;;
esac

export VECTOR_DATA_DIR="${VECTOR_DATA_DIR:-/data/vector}"
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://127.0.0.1:4317}"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:-$OTEL_EXPORTER_OTLP_ENDPOINT}"
export PAX_OTEL_EXPORTER_OTLP_ENDPOINT="${PAX_OTEL_EXPORTER_OTLP_ENDPOINT:-$OTEL_EXPORTER_OTLP_ENDPOINT}"

mkdir -p \
  "$VECTOR_DATA_DIR" \
  "${PAX_VECTOR_BUFFER_DIR:-/data/observability}" \
  "$(dirname "${PAX_HISTORY_PATH:-/app/var/history.jsonl}")"

echo "[observability] vector args: ${config_args[*]}"
exec vector "${config_args[@]}"
