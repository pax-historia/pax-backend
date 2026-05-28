// scripts/dev/spawn-engine.mts — launches rivet-engine for the local dev loop.
//
// Writes a per-run config under .data/run-<id>/ with file_system.path
// pointing at a fresh RocksDB directory. Tails stderr/stdout with a
// [engine] prefix so the local-up.sh output is readable.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const ENGINE_BINARY: string =
  process.env["ENGINE_BINARY"] ??
  join(REPO_ROOT, ".cache", "rivet-engine", "rivet-engine");
const DATA_DIR: string =
  process.env["PAX_ENGINE_DATA_DIR"] ?? join(REPO_ROOT, ".data");
const RESET_DB: boolean = (process.env["RESET_DB"] ?? "true") !== "false";
const ADMIN_TOKEN: string = process.env["RIVET_ADMIN_TOKEN"] ?? "dev";

interface EngineConfig {
  readonly auth: { readonly admin_token: string };
  readonly guard: {
    readonly host: string;
    readonly port: number;
    readonly tcp_nodelay: boolean;
    readonly enable_websocket_health_route: boolean;
    readonly actor_ready_timeout_ms: number;
    readonly route_timeout_ms: number;
  };
  readonly api_peer: { readonly host: string; readonly port: number };
  readonly metrics: { readonly host: string; readonly port: number };
  readonly topology: unknown;
  readonly file_system: { readonly path: string };
  readonly cache: { readonly enabled: boolean; readonly driver: string };
  readonly telemetry: { readonly enabled: boolean };
  readonly runtime: Readonly<Record<string, unknown>>;
}

if (!existsSync(ENGINE_BINARY)) {
  console.error(
    `[engine] binary not found at ${ENGINE_BINARY}. Run scripts/build/build-engine.sh first.`,
  );
  process.exit(1);
}

const runId = `${Date.now()}-${process.pid}`;
const runDir = join(DATA_DIR, `run-${runId}`);
const dbDir = join(runDir, "db");
mkdirSync(runDir, { recursive: true });
if (RESET_DB && existsSync(dbDir)) {
  rmSync(dbDir, { recursive: true, force: true });
}

const config: EngineConfig = {
  auth: { admin_token: ADMIN_TOKEN },
  guard: {
    host: "0.0.0.0",
    port: 6420,
    tcp_nodelay: true,
    enable_websocket_health_route: true,
    actor_ready_timeout_ms: 30_000,
    route_timeout_ms: 30_000,
  },
  api_peer: { host: "0.0.0.0", port: 6421 },
  metrics: { host: "0.0.0.0", port: 6430 },
  topology: {
    datacenter_label: 1,
    datacenters: {
      default: {
        datacenter_label: 1,
        is_leader: true,
        peer_url: "http://127.0.0.1:6421",
        public_url: "http://127.0.0.1:6420",
        valid_hosts: ["127.0.0.1", "localhost"],
      },
    },
  },
  file_system: { path: dbDir },
  cache: { enabled: true, driver: "in_memory" },
  telemetry: { enabled: false },
  runtime: {
    allow_version_rollback: true,
    guard_shutdown_duration: 30,
    force_shutdown_duration: 60,
  },
};

const configPath = join(runDir, "rivet-engine.config.json");
writeFileSync(configPath, JSON.stringify(config, null, 2));
console.error(`[engine] config: ${configPath}`);
console.error(`[engine] db:     ${dbDir}`);
console.error(`[engine] binary: ${ENGINE_BINARY}`);

const child: ChildProcessByStdio<null, Readable, Readable> = spawn(
  ENGINE_BINARY,
  ["--config", configPath, "start"],
  {
    env: {
      ...process.env,
      RUST_LOG:
        process.env["RUST_LOG"] ??
        "info,rivet_guard::routing::pegboard_gateway=info,pegboard_runner=info,pegboard_gateway=info,universalpubsub=info,gasoline=info",
      RUST_BACKTRACE: process.env["RUST_BACKTRACE"] ?? "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

prefixStream(child.stdout, "[engine] ");
prefixStream(child.stderr, "[engine] ");

child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
  console.error(`[engine] exited code=${code} signal=${signal}`);
  process.exit(code ?? 0);
});

function prefixStream(stream: Readable, prefix: string): void {
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) process.stdout.write(prefix + l + "\n");
  });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.error(`[engine] forwarding ${sig} to rivet-engine`);
    child.kill(sig);
  });
}
