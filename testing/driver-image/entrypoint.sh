#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/app}"
export PAX_DRIVER_HEALTH_BIND="${PAX_DRIVER_HEALTH_BIND:-0.0.0.0:9090}"
export PAX_HISTORY_PATH="${PAX_HISTORY_PATH:-/data/history/history.jsonl}"
export PAX_SERVICE_NAME="${PAX_SERVICE_NAME:-pax-backend-driver}"
export PAX_ZONE="${PAX_ZONE:-testing}"
export VECTOR_DATA_DIR="${VECTOR_DATA_DIR:-/data/vector}"
export OTEL_EXPORTER_OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://127.0.0.1:4317}"
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT="${OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:-$OTEL_EXPORTER_OTLP_ENDPOINT}"
export PAX_OTEL_EXPORTER_OTLP_ENDPOINT="${PAX_OTEL_EXPORTER_OTLP_ENDPOINT:-$OTEL_EXPORTER_OTLP_ENDPOINT}"

mkdir -p \
  "$(dirname "$PAX_HISTORY_PATH")" \
  "$VECTOR_DATA_DIR" \
  "${PAX_VECTOR_BUFFER_DIR:-/data/observability}"

pids=()

start_service() {
  local name="$1"
  shift
  echo "[driver-image] starting $name"
  "$@" &
  pids+=("$!")
}

terminate() {
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
}

trap 'terminate' TERM
trap 'terminate' INT

if [[ "${PAX_OBSERVABILITY:-on}" != "off" ]]; then
  start_service "vector" "$APP_ROOT/scripts/observability/start-vector.sh"
fi

if [[ "$#" -gt 0 ]]; then
  start_service "command" "$@"
  set +e
  wait -n "${pids[@]}"
  status="$?"
  terminate
  wait "${pids[@]}" 2>/dev/null
  exit "$status"
fi

PAX_DRIVER_HEALTH_BIND="$PAX_DRIVER_HEALTH_BIND" node <<'NODE' &
const http = require("node:http");

const bind = process.env.PAX_DRIVER_HEALTH_BIND ?? "0.0.0.0:9090";
const lastColon = bind.lastIndexOf(":");
const host = bind.slice(0, lastColon);
const port = Number.parseInt(bind.slice(lastColon + 1), 10);

http
  .createServer((req, res) => {
    if (req.url === "/health") {
      const body = JSON.stringify({ status: "ok", runtime: "scenario-driver" });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (req.url === "/metrics") {
      const body = [
        "# HELP pax_driver_health_ready Scenario driver health loop readiness.",
        "# TYPE pax_driver_health_ready gauge",
        "pax_driver_health_ready 1",
        "",
      ].join("\n");
      res.writeHead(200, {
        "content-type": "text/plain; version=0.0.4",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(port, host, () => {
    process.stdout.write(`[driver-image] health listening on http://${host}:${port}\n`);
  });
NODE
health_pid="$!"
pids+=("$health_pid")

echo "[driver-image] ready under $APP_ROOT"
set +e
wait -n "${pids[@]}"
status="$?"
terminate
wait "${pids[@]}" 2>/dev/null
exit "$status"
