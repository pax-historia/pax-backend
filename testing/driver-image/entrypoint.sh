#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -gt 0 ]]; then
  exec "$@"
fi

APP_ROOT="${APP_ROOT:-/app}"
PAX_DRIVER_HEALTH_BIND="${PAX_DRIVER_HEALTH_BIND:-0.0.0.0:9090}"
export PAX_HISTORY_PATH="${PAX_HISTORY_PATH:-/data/history/history.jsonl}"

mkdir -p "$(dirname "$PAX_HISTORY_PATH")"

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
    res.writeHead(404);
    res.end();
  })
  .listen(port, host, () => {
    process.stdout.write(`[driver-image] health listening on http://${host}:${port}\n`);
  });
NODE
health_pid="$!"

terminate() {
  if kill -0 "$health_pid" 2>/dev/null; then
    kill -TERM "$health_pid" 2>/dev/null || true
  fi
}

trap 'terminate' TERM
trap 'terminate' INT

echo "[driver-image] ready under $APP_ROOT"
wait "$health_pid"
