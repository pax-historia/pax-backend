// runtime/parent-actor — the platform-trusted RivetKit actor host.
//
// One Node process per shard machine. Runs:
//  - One @rivetkit/engine-runner connected to the local rivet-engine
//  - One "pax-game" actor whose websocket() callback verifies the placement
//    JWT, forks an isolated-vm child per game, and brokers IPC + WS frames.
//  - A 5-second self-registration loop that writes the shard's row into the
//    Redis registry the placement router reads (skipping the control plane
//    entirely for the smoke milestone).
//  - A per-shard history.jsonl writer that records every channel call,
//    lifecycle transition, and session transition (guarantee #14).
//  - Forwarding c.api.invoke calls to the API gateway with parent-owned
//    session context.
//
// What this process does NOT do (deferred):
//  - Native c.blob (Tigris) and c.state (RocksDB) adapters; this pass uses
//    Redis-backed storage under the same IPC contract.
//  - Compute-plane quota enforcement (we ship the per-handler timeout in the
//    child via ivm; the rest is M2+).

import { type ChildProcess, fork } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { Runner } from "@rivetkit/engine-runner";
import { Redis } from "ioredis";
import jwt from "jsonwebtoken";
import pino, { type Logger } from "pino";

import {
  ACTIVE_GAMES_KEY_PREFIX,
  ACTIVE_GAME_TTL_SECONDS,
  ALLOWED_PLAYERS_KEY_PREFIX,
  type ApiGatewayDispatchInput,
  type ApiInvokeError,
  type ApiInvokeIpcPayload,
  type ApiInvokeResponse,
  BLOB_KEY_PREFIX,
  BUNDLE_KEY_PREFIX,
  type BundleRecord,
  CHILD_TO_PARENT,
  type ChildToParentEnvelope,
  type ComputeBudgetSnapshot,
  type ConnectedSessionSnapshot,
  DEFAULT_BLOB_BYTES_LIMIT,
  DEFAULT_STATE_BYTES_LIMIT,
  type DisconnectReason,
  GAME_KEY_PREFIX,
  type GameRecord,
  type ParentToChildEnvelope,
  RUNTIME_CONTRACT_VERSION,
  SHARD_REGISTRY_KEY_PREFIX,
  SHARD_REGISTRY_TTL_SECONDS,
  STATE_KEY_PREFIX,
  type StorageReadResponsePayload,
  type StorageWriteResponse,
  type ShardRegistration,
  envelope,
  generateRunId,
  generateSessionId,
} from "@pax-backend/ipc-protocol";

// --- Config -------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const SHARD_ID = process.env["PAX_SHARD_ID"] ?? "shard-local";
const SHARD_PUBLIC_URL =
  process.env["PAX_SHARD_PUBLIC_URL"] ?? "http://127.0.0.1:6420";
const ENGINE_ENDPOINT =
  process.env["RIVET_ENGINE_ENDPOINT"] ?? "http://127.0.0.1:6420";
const ENGINE_ADMIN_TOKEN = process.env["RIVET_ADMIN_TOKEN"] ?? "dev";
const RIVET_NAMESPACE = process.env["RIVET_NAMESPACE"] ?? "pax-smoke";
const RIVET_RUNNER_NAME = process.env["RIVET_RUNNER_NAME"] ?? "pax-runner";
const RIVET_ACTOR_NAME = process.env["RIVET_ACTOR_NAME"] ?? "pax-game";
const RIVET_TOTAL_SLOTS = Number.parseInt(
  process.env["RIVET_TOTAL_SLOTS"] ?? "1000",
  10,
);

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
const PAX_JWT_SECRET = process.env["PAX_JWT_SECRET"] ?? "local-dev-secret";
const PAX_API_GATEWAY_URL =
  process.env["PAX_API_GATEWAY_URL"] ?? "http://127.0.0.1:9081/invoke";
const ALLOWED_PLAYERS_ENFORCE_INTERVAL_MS = Number.parseInt(
  process.env["PAX_ALLOWED_PLAYERS_ENFORCE_INTERVAL_MS"] ?? "5000",
  10,
);
const CPU_MS_PER_TICK_LIMIT = Number.parseInt(
  process.env["PAX_CPU_MS_PER_TICK_LIMIT"] ?? "1000",
  10,
);
const MEMORY_BYTES_LIMIT =
  Number.parseInt(process.env["PAX_MEMORY_BYTES_LIMIT"] ?? "134217728", 10);
const BANDWIDTH_BYTES_PER_SEC_LIMIT = Number.parseInt(
  process.env["PAX_BANDWIDTH_BYTES_PER_SEC_LIMIT"] ?? "65536",
  10,
);
const WS_MESSAGES_PER_SEC_LIMIT = Number.parseInt(
  process.env["PAX_WS_MESSAGES_PER_SEC_LIMIT"] ?? "50",
  10,
);
const STATE_BYTES_LIMIT = Number.parseInt(
  process.env["PAX_STATE_BYTES_LIMIT"] ?? String(DEFAULT_STATE_BYTES_LIMIT),
  10,
);
const BLOB_BYTES_LIMIT = Number.parseInt(
  process.env["PAX_BLOB_BYTES_LIMIT"] ?? String(DEFAULT_BLOB_BYTES_LIMIT),
  10,
);
const API_INVOCATIONS_PER_MIN_LIMIT = Number.parseInt(
  process.env["PAX_API_INVOCATIONS_PER_MIN"] ?? "60",
  10,
);

const HISTORY_PATH =
  process.env["PAX_HISTORY_PATH"] ?? join(REPO_ROOT, "var", "history.jsonl");
const BUNDLE_DIR = join(REPO_ROOT, "examples", "bundles");
const CHILD_RUNNER_ENTRY = join(
  REPO_ROOT,
  "runtime",
  "child-runner-ivm",
  "src",
  "child.mts",
);
const TSX_LOADER_ENTRY = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

// runtimeContractsSupported [min, max]. For smoke we ship version 1 and
// accept only games whose bundle.runtimeContractRequired == 1.
const RUNTIME_CONTRACTS_SUPPORTED: readonly [number, number] = [
  RUNTIME_CONTRACT_VERSION,
  RUNTIME_CONTRACT_VERSION,
];

const log: Logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  name: "parent",
});

// --- History writer -----------------------------------------------------

mkdirSync(dirname(HISTORY_PATH), { recursive: true });
const historyFd = openSync(HISTORY_PATH, "a");

interface HistoryFields {
  readonly actorId?: string;
  readonly gameId?: string;
  readonly sessionId?: string;
  readonly playerId?: string;
  readonly runId?: string;
  readonly [key: string]: unknown;
}

function history(event: string, fields: HistoryFields): void {
  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      shardId: SHARD_ID,
      event,
      ...fields,
    }) + "\n";
  writeSync(historyFd, line);
}

// --- Redis self-registration -------------------------------------------

const redis = new Redis(REDIS_URL, {
  lazyConnect: false,
  maxRetriesPerRequest: null,
});
redis.on("error", (err: Error) => log.warn({ err: err.message }, "redis error"));

const wakeMetrics = {
  recentWakes: 0,
  lastResetMs: performance.now(),
};

let activeGameCount = 0;

async function registerShard(): Promise<void> {
  const payload: ShardRegistration = {
    shardId: SHARD_ID,
    url: SHARD_PUBLIC_URL,
    healthy: true,
    acceptingWakes: true,
    runtimeContractsSupported: RUNTIME_CONTRACTS_SUPPORTED,
    activeGames: activeGameCount,
    cpuPct: 0,
    recentWakeRate: wakeMetrics.recentWakes,
    lastSeenAt: Date.now(),
    rivet: {
      namespace: RIVET_NAMESPACE,
      runnerName: RIVET_RUNNER_NAME,
      actorName: RIVET_ACTOR_NAME,
      adminTokenHint: "PAX_LOCAL_ENGINE_ADMIN_TOKEN",
    },
  };
  await redis.set(
    `${SHARD_REGISTRY_KEY_PREFIX}${SHARD_ID}`,
    JSON.stringify(payload),
    "EX",
    SHARD_REGISTRY_TTL_SECONDS,
  );
  const now = performance.now();
  if (now - wakeMetrics.lastResetMs > 1_000) {
    wakeMetrics.recentWakes = 0;
    wakeMetrics.lastResetMs = now;
  }
}

// --- Bundle loading ----------------------------------------------------

interface LoadedBundle {
  readonly name: string;
  readonly source: string;
  readonly manifest: BundleRecord["manifest"];
}

const bundleCache = new Map<string, LoadedBundle>();

function loadBundle(bundleName: string): LoadedBundle {
  const cached = bundleCache.get(bundleName);
  if (cached) return cached;
  // For smoke, bundleName resolves to examples/bundles/<name>/dist/bundle.js
  // (the esbuild-IIFE output of the .mts source).
  const compiledPath = join(BUNDLE_DIR, bundleName, "dist", "bundle.js");
  const source = readFileSync(compiledPath, "utf8");
  const manifest = extractManifestFromSource(source);
  const record: LoadedBundle = { name: bundleName, source, manifest };
  bundleCache.set(bundleName, record);
  return record;
}

function extractManifestFromSource(source: string): BundleRecord["manifest"] {
  // The compiled bundle calls `__pax_install(defineBundle({...}))`. We
  // capture the installed definition's manifest by stubbing both globals.
  // Same stub the ivm child uses, run on the host for manifest extraction.
  let captured: BundleRecord["manifest"] | undefined;
  const stub = `
    let __m;
    function defineBundle(d) {
      if (!d || !d.manifest) throw new Error("defineBundle: manifest required");
      return d;
    }
    function __pax_install(d) { __m = d.manifest; }
    ${source}
    return __m;
  `;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function(stub) as () => BundleRecord["manifest"];
  captured = fn();
  if (!captured) {
    throw new Error("bundle source did not produce a manifest");
  }
  return captured;
}

// --- Per-game state ----------------------------------------------------

interface SessionRecord {
  readonly ws: WsLike;
  readonly sessionId: string;
  readonly playerId: string;
  readonly connectedAt: number;
  readonly jwtClaims: Readonly<Record<string, unknown>>;
  disconnectReason?: DisconnectReason;
  seq: number;
}

interface UsageSample {
  readonly at: number;
  readonly amount: number;
}

interface GameInstance {
  readonly actorId: string;
  readonly gameId: string;
  readonly bundleName: string;
  readonly bundleCompatTag: string;
  blobCompatTag?: string;
  readonly runId: string;
  child: ChildProcess | null;
  readonly sessions: Map<string, SessionRecord>;
  readonly wsUsageSamples: UsageSample[];
  readonly apiInvokeSamples: UsageSample[];
  stateBytes: number;
  blobBytes: number;
  ready: boolean;
  bootstrapPromise: Promise<void> | null;
}

// Minimal WebSocket-ish surface the engine-runner hands us. The vendored
// engine-runner uses a `WebSocketTunnelAdapter` that implements the standard
// WebSocket EventTarget surface; we type only what we use.
interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code: number; reason?: string }) => void,
  ): void;
}

const games = new Map<string, GameInstance>();

if (
  Number.isFinite(ALLOWED_PLAYERS_ENFORCE_INTERVAL_MS) &&
  ALLOWED_PLAYERS_ENFORCE_INTERVAL_MS > 0
) {
  setInterval(() => {
    void enforceAllowedPlayersForAllGames();
  }, ALLOWED_PLAYERS_ENFORCE_INTERVAL_MS).unref();
}

function ensureGame(
  actorId: string,
  gameId: string,
  bundleName: string,
  blobCompatTag?: string,
): GameInstance {
  const existing = games.get(actorId);
  if (existing) return existing;
  const bundle = loadBundle(bundleName);
  const runId = generateRunId();
  const inst: GameInstance = {
    actorId,
    gameId,
    bundleName,
    bundleCompatTag: bundle.manifest.compatTagProduced,
    blobCompatTag,
    runId,
    child: null,
    sessions: new Map(),
    wsUsageSamples: [],
    apiInvokeSamples: [],
    stateBytes: 0,
    blobBytes: 0,
    ready: false,
    bootstrapPromise: null,
  };
  games.set(actorId, inst);
  activeGameCount = games.size;
  history("game.created", { actorId, gameId, bundleName, runId });
  return inst;
}

function forkChild(inst: GameInstance): Promise<void> {
  if (inst.bootstrapPromise) return inst.bootstrapPromise;
  inst.bootstrapPromise = new Promise<void>((resolveReady, rejectReady) => {
    const bundle = loadBundle(inst.bundleName);
    // Fork the child via tsx so we can run the .mts source directly. The
    // production shard image will compile to .mjs at image-build time and
    // skip tsx; in the local dev loop tsx is the no-build-step shortcut.
    const child = fork(TSX_LOADER_ENTRY, [CHILD_RUNNER_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        // Trust model: no env to the child. Only what node/tsx needs.
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        NODE_OPTIONS: "",
        PAX_ROLE: "child",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });
    inst.child = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trimEnd();
      if (text) log.debug({ actorId: inst.actorId, child: "stdout" }, text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trimEnd();
      if (text) log.warn({ actorId: inst.actorId, child: "stderr" }, text);
    });

    child.on("exit", (code, signal) => {
      log.warn({ actorId: inst.actorId, code, signal }, "child exited");
      history("child.exit", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        code,
        signal,
      });
      inst.ready = false;
    });

    child.on("message", (raw: unknown) => {
      handleChildIpc(inst, raw);
    });

    child.on("error", (err: Error) => {
      log.error({ actorId: inst.actorId, err: err.message }, "child error");
      rejectReady(err);
    });

    // One-shot ready watcher; remove itself once ready fires.
    const readyHandler = (raw: unknown): void => {
      if (!isChildEnvelope(raw) || raw.type !== CHILD_TO_PARENT.ready) return;
      child.off("message", readyHandler);
      inst.ready = true;
      void sendWakeAfterHydration(child, inst, resolveReady, rejectReady);
    };
    child.on("message", readyHandler);

    sendTyped(child, "bootstrap", {
      bundleName: inst.bundleName,
      bundleSource: bundle.source,
      bundleCompatTag: inst.bundleCompatTag,
      runId: inst.runId,
      gameId: inst.gameId,
      memoryLimitMb: 128,
    });
  });
  return inst.bootstrapPromise;
}

async function sendWakeAfterHydration(
  child: ChildProcess,
  inst: GameInstance,
  resolveReady: () => void,
  rejectReady: (err: Error) => void,
): Promise<void> {
  try {
    const [state, blob] = await Promise.all([
      readGameStorage(inst, "state"),
      readGameStorage(inst, "blob"),
    ]);
    sendTyped(child, "onWake", {
      reason: "cold-start",
      runId: inst.runId,
      bundleName: inst.bundleName,
      bundleCompatTag: inst.bundleCompatTag,
      blobCompatTag: inst.blobCompatTag,
      state: state.found ? state.value : undefined,
      blob: blob.found ? blob.value : undefined,
    });
    history("onWake.sent", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      reason: "cold-start",
      stateBytes: state.bytes,
      blobBytes: blob.bytes,
      blobCompatTag: inst.blobCompatTag,
    });
    resolveReady();
  } catch (err) {
    rejectReady(err instanceof Error ? err : new Error(String(err)));
  }
}

function sendTyped<T extends ParentToChildEnvelope["type"]>(
  child: ChildProcess,
  type: T,
  payload: Extract<ParentToChildEnvelope, { type: T }>["payload"],
  requestId?: string,
): void {
  const env = envelope(type, payload, requestId);
  child.send(env);
}

function isChildEnvelope(raw: unknown): raw is ChildToParentEnvelope {
  return (
    !!raw &&
    typeof raw === "object" &&
    "version" in raw &&
    "type" in raw &&
    "payload" in raw
  );
}

function handleChildIpc(inst: GameInstance, raw: unknown): void {
  if (!isChildEnvelope(raw)) return;
  switch (raw.type) {
    case CHILD_TO_PARENT.ready:
      return; // handled by the one-shot readyHandler in forkChild
    case CHILD_TO_PARENT.apiInvoke:
      void handleApiInvoke(inst, raw.requestId, raw.payload);
      return;
    case CHILD_TO_PARENT.playersAllowed:
      void handlePlayersAllowed(inst, raw.requestId);
      return;
    case CHILD_TO_PARENT.playersConnected:
      handlePlayersConnected(inst, raw.requestId);
      return;
    case CHILD_TO_PARENT.computeBudget:
      handleComputeBudget(inst, raw.requestId);
      return;
    case CHILD_TO_PARENT.stateRead:
      void handleStorageRead(inst, raw.requestId, "state");
      return;
    case CHILD_TO_PARENT.stateWrite:
      void handleStorageWrite(inst, raw.requestId, "state", raw.payload.value);
      return;
    case CHILD_TO_PARENT.stateFlush:
      handleStateFlush(inst, raw.requestId);
      return;
    case CHILD_TO_PARENT.blobRead:
      void handleStorageRead(inst, raw.requestId, "blob");
      return;
    case CHILD_TO_PARENT.blobWrite:
      void handleStorageWrite(inst, raw.requestId, "blob", raw.payload.value);
      return;
    case CHILD_TO_PARENT.wsSend:
      handleWsSend(inst, raw.payload);
      return;
    case CHILD_TO_PARENT.logEmit:
      history("log.emit", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        runId: inst.runId,
        bundleName: inst.bundleName,
        bundleCompatTag: inst.bundleCompatTag,
        payload: raw.payload,
      });
      return;
    case CHILD_TO_PARENT.metricsEmit:
      history("metrics.emit", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        runId: inst.runId,
        bundleName: inst.bundleName,
        bundleCompatTag: inst.bundleCompatTag,
        payload: raw.payload,
      });
      return;
    case CHILD_TO_PARENT.lifecycleRequestSleep:
      history("lifecycle.requestSleep", {
        actorId: inst.actorId,
        gameId: inst.gameId,
      });
      return;
    case "child.fatal":
      history("child.fatal", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        ...raw.payload,
      });
      log.error({ actorId: inst.actorId, ...raw.payload }, "child.fatal");
      return;
    case "child.handlerError":
      history("child.handlerError", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        ...raw.payload,
      });
      log.warn(
        { actorId: inst.actorId, ...raw.payload },
        "child handler error",
      );
      return;
    case "child.unknownMessage":
      log.warn(
        { actorId: inst.actorId, payload: raw.payload },
        "child reported unknown message",
      );
      return;
    default: {
      const _exhaustive: never = raw;
      void _exhaustive;
    }
  }
}

async function handlePlayersAllowed(
  inst: GameInstance,
  requestId: string | undefined,
): Promise<void> {
  if (!requestId) {
    history("players.allowed.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      reason: "missingRequestId",
    });
    return;
  }
  try {
    const players = Array.from(await allowedPlayersForGame(inst.gameId)).sort();
    history("players.allowed", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      requestId,
      count: players.length,
    });
    if (inst.child) {
      sendTyped(inst.child, "players.allowed.response", { players }, requestId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    history("players.allowed.error", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      requestId,
      error: msg,
    });
    if (inst.child) {
      sendTyped(inst.child, "players.allowed.response", { players: [] }, requestId);
    }
  }
}

function handlePlayersConnected(
  inst: GameInstance,
  requestId: string | undefined,
): void {
  if (!requestId) {
    history("players.connected.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      reason: "missingRequestId",
    });
    return;
  }
  const players = connectedSessionSnapshot(inst);
  history("players.connected", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    requestId,
    count: players.length,
  });
  if (inst.child) {
    sendTyped(inst.child, "players.connected.response", { players }, requestId);
  }
}

function handleComputeBudget(
  inst: GameInstance,
  requestId: string | undefined,
): void {
  if (!requestId) {
    history("compute.budget.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      reason: "missingRequestId",
    });
    return;
  }
  const budget = computeBudgetSnapshot(inst);
  history("compute.budget", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    requestId,
  });
  if (inst.child) {
    sendTyped(inst.child, "compute.budget.response", { budget }, requestId);
  }
}

async function handleStorageRead(
  inst: GameInstance,
  requestId: string | undefined,
  tier: "state" | "blob",
): Promise<void> {
  if (!requestId) {
    history(`${tier}.read.rejected`, {
      actorId: inst.actorId,
      gameId: inst.gameId,
      reason: "missingRequestId",
    });
    return;
  }
  const response = await readGameStorage(inst, tier);
  history(`${tier}.read`, {
    actorId: inst.actorId,
    gameId: inst.gameId,
    requestId,
    found: response.found,
    bytes: response.bytes,
  });
  if (!inst.child) return;
  if (tier === "state") {
    sendTyped(inst.child, "state.read.response", response, requestId);
  } else {
    sendTyped(inst.child, "blob.read.response", response, requestId);
  }
}

async function handleStorageWrite(
  inst: GameInstance,
  requestId: string | undefined,
  tier: "state" | "blob",
  value: unknown,
): Promise<void> {
  if (!requestId) {
    history(`${tier}.write.rejected`, {
      actorId: inst.actorId,
      gameId: inst.gameId,
      reason: "missingRequestId",
    });
    return;
  }
  const response = await writeGameStorage(inst, tier, value);
  history(`${tier}.write`, {
    actorId: inst.actorId,
    gameId: inst.gameId,
    requestId,
    ok: response.ok,
    error: response.ok ? undefined : response.error,
  });
  if (!inst.child) return;
  if (tier === "state") {
    sendTyped(inst.child, "state.write.response", { response }, requestId);
  } else {
    sendTyped(inst.child, "blob.write.response", { response }, requestId);
  }
}

function handleStateFlush(
  inst: GameInstance,
  requestId: string | undefined,
): void {
  if (!requestId) {
    history("state.flush.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      reason: "missingRequestId",
    });
    return;
  }
  const response: StorageWriteResponse = { ok: true };
  history("state.flush", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    requestId,
    ok: true,
  });
  if (inst.child) {
    sendTyped(inst.child, "state.flush.response", { response }, requestId);
  }
}

async function handleApiInvoke(
  inst: GameInstance,
  requestId: string | undefined,
  payload: ApiInvokeIpcPayload,
): Promise<void> {
  if (!requestId) {
    history("api.invoke.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      kind: payload.kind,
      reason: "missingRequestId",
    });
    return;
  }
  const triggeringSession =
    payload.triggeringSessionId === null
      ? undefined
      : inst.sessions.get(payload.triggeringSessionId);
  recordApiInvokeUsage(inst);
  const input: ApiGatewayDispatchInput = {
    kind: payload.kind,
    args: payload.args,
    idempotencyKey: payload.idempotencyKey,
    gameId: inst.gameId,
    triggeringSessionId: triggeringSession?.sessionId ?? null,
    triggeringJwtClaims: triggeringSession?.jwtClaims ?? null,
    connectedSessions: connectedSessionSnapshot(inst),
    bundleName: inst.bundleName,
    bundleCompatTag: inst.bundleCompatTag,
    runId: inst.runId,
  };

  history("api.invoke.request", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    requestId,
    kind: payload.kind,
    triggeringSessionId: input.triggeringSessionId,
    connectedSessionCount: input.connectedSessions.length,
  });

  const response = await dispatchApiInvoke(input);
  history("api.invoke.response", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    requestId,
    kind: payload.kind,
    ok: response.ok,
    error: response.ok ? undefined : response.error,
  });
  if (inst.child) {
    sendTyped(inst.child, "api.invoke.response", { response }, requestId);
  }
}

async function dispatchApiInvoke(
  input: ApiGatewayDispatchInput,
): Promise<ApiInvokeResponse> {
  try {
    const res = await fetch(PAX_API_GATEWAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const raw = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error: "providerError",
        detail: { statusCode: res.status, body: raw },
      };
    }
    return parseApiInvokeResponse(raw);
  } catch (err) {
    return {
      ok: false,
      error: "providerError",
      detail: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

function parseApiInvokeResponse(raw: string): ApiInvokeResponse {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed["ok"] === true) {
    return { ok: true, result: parsed["result"] };
  }
  const error = parsed["error"];
  if (parsed["ok"] === false && isApiInvokeError(error)) {
    return { ok: false, error, detail: parsed["detail"] };
  }
  return {
    ok: false,
    error: "providerError",
    detail: { message: "gateway returned malformed api.invoke response", raw },
  };
}

function isApiInvokeError(value: unknown): value is ApiInvokeError {
  return (
    value === "kindUnknown" ||
    value === "providerError" ||
    value === "apiRateExceeded" ||
    value === "replayCoverageGap"
  );
}

async function isPlayerAllowed(gameId: string, playerId: string): Promise<boolean> {
  const allowed = await redis.sismember(
    `${ALLOWED_PLAYERS_KEY_PREFIX}${gameId}`,
    playerId,
  );
  return allowed === 1;
}

async function allowedPlayersForGame(gameId: string): Promise<ReadonlySet<string>> {
  return new Set(await redis.smembers(`${ALLOWED_PLAYERS_KEY_PREFIX}${gameId}`));
}

async function enforceAllowedPlayersForAllGames(): Promise<void> {
  for (const inst of games.values()) {
    if (inst.sessions.size === 0) continue;
    try {
      const allowed = await allowedPlayersForGame(inst.gameId);
      for (const sess of inst.sessions.values()) {
        if (!allowed.has(sess.playerId)) {
          disconnectSession(inst, sess, "removedFromAllowedPlayers");
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        { actorId: inst.actorId, gameId: inst.gameId, err: msg },
        "allowed-players enforcement failed",
      );
    }
  }
}

function disconnectSession(
  inst: GameInstance,
  sess: SessionRecord,
  reason: DisconnectReason,
): void {
  if (sess.disconnectReason) return;
  sess.disconnectReason = reason;
  history("session.forceDisconnect", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    sessionId: sess.sessionId,
    playerId: sess.playerId,
    reason,
  });
  try {
    sess.ws.close(1008, reason);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(
      {
        actorId: inst.actorId,
        gameId: inst.gameId,
        sessionId: sess.sessionId,
        err: msg,
      },
      "force disconnect failed",
    );
  }
}

function connectedSessionSnapshot(inst: GameInstance): readonly ConnectedSessionSnapshot[] {
  return Array.from(inst.sessions.values()).map((session) => ({
    sessionId: session.sessionId,
    playerId: session.playerId,
    connectedAt: session.connectedAt,
  }));
}

async function readGameStorage(
  inst: GameInstance,
  tier: "state" | "blob",
): Promise<StorageReadResponsePayload> {
  const raw = await redis.get(storageKey(inst.gameId, tier));
  if (raw === null) {
    if (tier === "state") inst.stateBytes = 0;
    else inst.blobBytes = 0;
    return { found: false, bytes: 0 };
  }
  const bytes = Buffer.byteLength(raw, "utf8");
  if (tier === "state") inst.stateBytes = bytes;
  else inst.blobBytes = bytes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { found: false, bytes };
  }
  return parsed &&
    typeof parsed === "object" &&
    Object.prototype.hasOwnProperty.call(parsed, "value")
    ? { found: true, value: (parsed as { value?: unknown }).value, bytes }
    : { found: true, value: parsed, bytes };
}

async function writeGameStorage(
  inst: GameInstance,
  tier: "state" | "blob",
  value: unknown,
): Promise<StorageWriteResponse> {
  let raw: string;
  try {
    raw = JSON.stringify({ value });
  } catch (err) {
    return {
      ok: false,
      error: "storageUnavailable",
      detail: { message: err instanceof Error ? err.message : String(err) },
    };
  }
  const bytes = Buffer.byteLength(raw, "utf8");
  const limit = tier === "state" ? STATE_BYTES_LIMIT : BLOB_BYTES_LIMIT;
  if (bytes > limit) {
    return {
      ok: false,
      error: "sizeExceeded",
      detail: { bytes, limit },
    };
  }
  try {
    await redis.set(storageKey(inst.gameId, tier), raw);
  } catch (err) {
    return {
      ok: false,
      error: "storageUnavailable",
      detail: { message: err instanceof Error ? err.message : String(err) },
    };
  }
  if (tier === "state") inst.stateBytes = bytes;
  else inst.blobBytes = bytes;
  return { ok: true };
}

function storageKey(gameId: string, tier: "state" | "blob"): string {
  return `${tier === "state" ? STATE_KEY_PREFIX : BLOB_KEY_PREFIX}${gameId}`;
}

function recordWsUsage(inst: GameInstance, bytes: number): void {
  inst.wsUsageSamples.push({ at: Date.now(), amount: bytes });
  pruneUsageSamples(inst.wsUsageSamples, 1_000);
}

function recordApiInvokeUsage(inst: GameInstance): void {
  inst.apiInvokeSamples.push({ at: Date.now(), amount: 1 });
  pruneUsageSamples(inst.apiInvokeSamples, 60_000);
}

function computeBudgetSnapshot(inst: GameInstance): ComputeBudgetSnapshot {
  const wsSamples = pruneUsageSamples(inst.wsUsageSamples, 1_000);
  const apiSamples = pruneUsageSamples(inst.apiInvokeSamples, 60_000);
  const bandwidthBytes = wsSamples.reduce((sum, sample) => sum + sample.amount, 0);
  const wsMessages = wsSamples.length;
  const apiInvocations = apiSamples.reduce((sum, sample) => sum + sample.amount, 0);
  return {
    "cpu-ms-per-tick": {
      currentUsage: 0,
      limit: CPU_MS_PER_TICK_LIMIT,
    },
    "memory-bytes": {
      currentUsage: process.memoryUsage().rss,
      limit: MEMORY_BYTES_LIMIT,
    },
    "bandwidth-bytes-per-sec": {
      currentUsage: bandwidthBytes,
      limit: BANDWIDTH_BYTES_PER_SEC_LIMIT,
      windowMs: 1_000,
    },
    "ws-messages-per-sec": {
      currentUsage: wsMessages,
      limit: WS_MESSAGES_PER_SEC_LIMIT,
      windowMs: 1_000,
    },
    "state-bytes": {
      currentUsage: inst.stateBytes,
      limit: STATE_BYTES_LIMIT,
    },
    "blob-bytes": {
      currentUsage: inst.blobBytes,
      limit: BLOB_BYTES_LIMIT,
    },
    "api-invocations-per-min": {
      currentUsage: apiInvocations,
      limit: API_INVOCATIONS_PER_MIN_LIMIT,
      windowMs: 60_000,
    },
  };
}

function pruneUsageSamples(
  samples: UsageSample[],
  windowMs: number,
): readonly UsageSample[] {
  const cutoff = Date.now() - windowMs;
  let firstKept = 0;
  while (firstKept < samples.length && (samples[firstKept]?.at ?? 0) < cutoff) {
    firstKept += 1;
  }
  if (firstKept > 0) {
    samples.splice(0, firstKept);
  }
  return samples;
}

function handleWsSend(
  inst: GameInstance,
  payload: Extract<ChildToParentEnvelope, { type: "ws.send" }>["payload"],
): void {
  const { target, body } = payload;
  const text = JSON.stringify(body);
  const sessions = Array.from(inst.sessions.values());
  const targets: SessionRecord[] =
    target === "all"
      ? sessions
      : Array.isArray(target)
        ? sessions.filter((s) => (target as readonly string[]).includes(s.playerId))
        : sessions.filter((s) => s.playerId === target);

  for (const sess of targets) {
    try {
      sess.ws.send(text);
      recordWsUsage(inst, text.length);
      history("ws.send", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        sessionId: sess.sessionId,
        playerId: sess.playerId,
        bytes: text.length,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ actorId: inst.actorId, err: msg }, "ws.send failed");
    }
  }
}

// --- JWT verify --------------------------------------------------------

interface PlacementClaims {
  readonly gameId: string;
  readonly shardId: string;
  readonly userId: string;
  readonly bundleName: string;
  readonly runId: string;
  readonly exp: number;
}

function verifyPlacementToken(token: string): PlacementClaims {
  const decoded = jwt.verify(token, PAX_JWT_SECRET, {
    algorithms: ["HS256"],
  });
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("placement token decoded to non-object");
  }
  const claims = decoded as Partial<PlacementClaims> & jwt.JwtPayload;
  if (
    typeof claims.gameId !== "string" ||
    typeof claims.shardId !== "string" ||
    typeof claims.userId !== "string" ||
    typeof claims.bundleName !== "string" ||
    typeof claims.runId !== "string" ||
    typeof claims.exp !== "number"
  ) {
    throw new Error("placement token missing required claims");
  }
  return claims as PlacementClaims;
}

// --- Runner ------------------------------------------------------------

interface ActorConfig {
  readonly key: string | null;
}

const runner = new Runner({
  logger: log.child({ component: "engine-runner" }),
  version: 1,
  endpoint: ENGINE_ENDPOINT,
  token: ENGINE_ADMIN_TOKEN,
  namespace: RIVET_NAMESPACE,
  totalSlots: RIVET_TOTAL_SLOTS,
  runnerName: RIVET_RUNNER_NAME,
  prepopulateActorNames: {},
  noAutoShutdown: true,

  onConnected: (): void => {
    log.info({ shardId: SHARD_ID }, "engine-runner connected");
  },
  onDisconnected: (code: number, reason: string): void => {
    log.warn({ code, reason }, "engine-runner disconnected");
  },
  onShutdown: (): void => {
    log.info("engine-runner shutdown");
  },

  fetch: async (): Promise<Response> => new Response("ok"),

  websocket: async (
    _runner,
    actorId: string,
    ws: WsLike,
    _gatewayId,
    _requestId,
    request: Request,
  ): Promise<void> => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      ws.close(1008, "bad request url");
      return;
    }
    const placementTokenStr = url.searchParams.get("placementToken");
    if (!placementTokenStr) {
      ws.close(1008, "missing placementToken");
      return;
    }
    let claims: PlacementClaims;
    try {
      claims = verifyPlacementToken(placementTokenStr);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, "placement token invalid");
      ws.close(1008, "invalid placementToken");
      return;
    }
    if (claims.shardId !== SHARD_ID) {
      ws.close(1008, "wrong shard");
      return;
    }

    const inst = games.get(actorId);
    if (!inst) {
      log.error({ actorId }, "websocket arrived before actor start");
      ws.close(1011, "actor not ready");
      return;
    }
    const playerId = claims.userId;
    const allowed = await isPlayerAllowed(inst.gameId, playerId);
    if (!allowed) {
      history("connection.refused", {
        actorId,
        gameId: inst.gameId,
        playerId,
        reason: "notAllowed",
      });
      ws.close(1008, "player not allowed");
      return;
    }
    await forkChild(inst);

    const sessionId = generateSessionId();
    const connectedAt = Date.now();
    const sess: SessionRecord = {
      ws,
      sessionId,
      playerId,
      connectedAt,
      jwtClaims: claims as unknown as Readonly<Record<string, unknown>>,
      seq: 0,
    };
    inst.sessions.set(sessionId, sess);

    history("session.opened", {
      actorId,
      gameId: inst.gameId,
      sessionId,
      playerId,
      jwtClaims: claims,
      connectedAt,
    });

    if (!inst.child) {
      ws.close(1011, "child not forked");
      return;
    }
    sendTyped(inst.child, "onPlayerConnect", {
      playerId,
      sessionId,
      jwtClaims: claims as unknown as Record<string, unknown>,
      connectedAt,
    });

    ws.addEventListener("message", (event: { data: unknown }) => {
      let body: unknown;
      try {
        const text =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data as ArrayBuffer).toString("utf8");
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      sess.seq += 1;
      history("onPlayerMessage", {
        actorId,
        gameId: inst.gameId,
        sessionId,
        playerId,
        seq: sess.seq,
      });
      if (inst.child) {
        sendTyped(inst.child, "onPlayerMessage", {
          playerId,
          sessionId,
          seq: sess.seq,
          body,
        });
      }
    });

    ws.addEventListener(
      "close",
      (event: { code: number; reason?: string }) => {
        inst.sessions.delete(sessionId);
        const disconnectReason = sess.disconnectReason ?? "left";
        history("session.closed", {
          actorId,
          gameId: inst.gameId,
          sessionId,
          playerId,
          code: event.code,
          reason: disconnectReason,
          transportReason: event.reason ? String(event.reason) : undefined,
        });
        if (inst.child) {
          sendTyped(inst.child, "onPlayerDisconnect", {
            playerId,
            sessionId,
            reason: disconnectReason,
          });
        }
      },
    );
  },

  hibernatableWebSocket: { canHibernate: (): boolean => false },

  onActorStart: async (
    actorId: string,
    _generation: number,
    actorConfig: ActorConfig,
  ): Promise<void> => {
    const gameId = actorConfig.key ?? actorId;
    let bundleName = "hello-ws-echo";
    let blobCompatTag: string | undefined;
    try {
      const gameRaw = await redis.get(`${GAME_KEY_PREFIX}${gameId}`);
      if (gameRaw) {
        const game = JSON.parse(gameRaw) as GameRecord;
        if (typeof game.bundleName === "string") bundleName = game.bundleName;
        if (typeof game.blobCompatTag === "string") blobCompatTag = game.blobCompatTag;
      } else {
        log.warn(
          { gameId },
          "no games:<id> record found; falling back to hello-ws-echo",
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ gameId, err: msg }, "redis games lookup failed");
    }
    const inst = ensureGame(actorId, gameId, bundleName, blobCompatTag);
    wakeMetrics.recentWakes += 1;
    log.info({ actorId, gameId, bundleName }, "actor start; forking child");
    await forkChild(inst);
    try {
      await redis.set(
        `${ACTIVE_GAMES_KEY_PREFIX}${gameId}`,
        JSON.stringify({
          gameId,
          shardId: SHARD_ID,
          actorId,
          placedAt: Date.now(),
          refreshedAt: Date.now(),
          generation: 1,
        }),
        "EX",
        ACTIVE_GAME_TTL_SECONDS,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ gameId, err: msg }, "active_games set failed");
    }
  },

  onActorStop: async (actorId: string, _generation: number): Promise<void> => {
    const inst = games.get(actorId);
    if (!inst) return;
    log.info({ actorId, gameId: inst.gameId }, "actor stop");
    history("actor.stop", { actorId, gameId: inst.gameId });
    try {
      inst.child?.kill();
    } catch {
      /* ignore */
    }
    games.delete(actorId);
    activeGameCount = games.size;
  },
});

// --- Engine bootstrap (namespace + runner config) ----------------------

interface DatacentersResponse {
  readonly datacenters?: readonly { readonly name: string }[];
}

async function engineFetch<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(path, ENGINE_ENDPOINT);
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${ENGINE_ADMIN_TOKEN}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`engine ${method} ${path} -> ${res.status} ${text}`);
  }
  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}

async function ensureNamespaceAndRunner(): Promise<void> {
  const start = performance.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await engineFetch<DatacentersResponse>("GET", "/datacenters");
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (performance.now() - start > 90_000) {
        throw new Error(`engine not ready after 90s: ${msg}`);
      }
      await new Promise<void>((r) => setTimeout(r, 250));
    }
  }
  try {
    await engineFetch("POST", "/namespaces", {
      name: RIVET_NAMESPACE,
      display_name: RIVET_NAMESPACE,
    });
    log.info({ namespace: RIVET_NAMESPACE }, "namespace created");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/409|name_not_unique|already.exists/i.test(msg)) throw err;
    log.info({ namespace: RIVET_NAMESPACE }, "namespace already exists");
  }
  const datacenters = await engineFetch<DatacentersResponse>(
    "GET",
    `/datacenters?namespace=${encodeURIComponent(RIVET_NAMESPACE)}`,
  );
  const dcName = datacenters.datacenters?.[0]?.name ?? "default";
  await engineFetch(
    "PUT",
    `/runner-configs/${encodeURIComponent(RIVET_RUNNER_NAME)}?namespace=${encodeURIComponent(
      RIVET_NAMESPACE,
    )}`,
    {
      datacenters: {
        [dcName]: { normal: {} },
      },
    },
  );
  log.info({ runnerName: RIVET_RUNNER_NAME, dcName }, "runner config upserted");
}

// --- Boot ---------------------------------------------------------------

async function main(): Promise<void> {
  // Touch the bundle records used by the bundle/games seeding path so the
  // typed BUNDLE_KEY_PREFIX import is exercised at boot (parent-actor
  // doesn't otherwise consume bundle Redis rows — those are the router's
  // concern).
  void BUNDLE_KEY_PREFIX;

  log.info(
    {
      shardId: SHARD_ID,
      engine: ENGINE_ENDPOINT,
      namespace: RIVET_NAMESPACE,
      runnerName: RIVET_RUNNER_NAME,
      actorName: RIVET_ACTOR_NAME,
      runtimeContractsSupported: RUNTIME_CONTRACTS_SUPPORTED,
      historyPath: HISTORY_PATH,
    },
    "parent-actor boot",
  );

  await ensureNamespaceAndRunner();
  await runner.start();

  await registerShard();
  setInterval(() => {
    registerShard().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, "shard register failed");
    });
  }, 5_000);

  log.info({ shardId: SHARD_ID }, "parent-actor ready");
  history("parent.ready", {
    shardId: SHARD_ID,
    runtimeContractsSupported: RUNTIME_CONTRACTS_SUPPORTED,
  });
}

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, "shutting down");
  try {
    for (const inst of games.values()) {
      inst.child?.kill();
    }
    await redis.quit();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, "shutdown error");
  }
  process.exit(0);
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM").catch(() => process.exit(1));
});
process.on("SIGINT", () => {
  shutdown("SIGINT").catch(() => process.exit(1));
});

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log.error({ err: msg }, "parent fatal");
  process.exit(1);
});
