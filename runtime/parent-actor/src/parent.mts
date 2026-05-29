// runtime/parent-actor — the platform-trusted RivetKit actor host.
//
// One Node process per shard machine. Runs:
//  - One @rivetkit/engine-runner connected to the local rivet-engine
//  - One "pax-game" actor whose websocket() callback verifies the placement
//    JWT, forks a child runner per game, and brokers IPC + WS frames.
//  - A 5-second self-registration loop that writes the shard's row into the
//    Redis registry the placement router reads (skipping the control plane
//    entirely for the smoke milestone).
//  - A per-shard history.jsonl writer that records every channel call,
//    lifecycle transition, and session transition (guarantee #14).
//  - Forwarding c.api.invoke calls to the API gateway with parent-owned
//    session context.
//
// What this process does NOT do (deferred):
//  - Native keyed c.blob (Tigris) adapter; this pass keeps the legacy
//    single-object blob IPC path until the wider blob contract migration.
//  - Full CPU/RAM kill enforcement. This pass exposes budget snapshots and
//    enforces storage/API/WS usage under the same compute-plane contract.

import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Runner } from "@rivetkit/engine-runner";
import { decode as cborDecode, encode as cborEncode } from "cborg";
import { Redis } from "ioredis";
import jwt from "jsonwebtoken";
import pino, { type Logger } from "pino";

import { startPaxNodeTelemetry } from "@pax-backend/node-telemetry";
import {
  ACTIVE_GAMES_KEY_PREFIX,
  ACTIVE_GAME_TTL_SECONDS,
  ALLOWED_PLAYERS_KEY_PREFIX,
  type ApiGatewayDispatchInput,
  type ApiGatewayInvokeResult,
  type ApiInvokeError,
  type ApiInvokeIpcPayload,
  type ApiInvokeResponse,
  type ApiInvokeWireRecord,
  BUNDLE_KEY_PREFIX,
  type BundleRecord,
  type ChildHandlerCompletePayload,
  type ChildHandlerErrorPayload,
  CHILD_TO_PARENT,
  type ChildToParentEnvelope,
  type ComputeBudgetName,
  type ComputeBudgetSnapshot,
  type ComputeBudgetUsage,
  type ConnectedSessionSnapshot,
  DEFAULT_BLOB_BYTES_LIMIT,
  DEFAULT_BLOB_KEYS_LIMIT,
  DEFAULT_STATE_BYTES_LIMIT,
  type DisconnectReason,
  GAME_KEY_PREFIX,
  type GameRecord,
  HOST_EVENT_QUEUE_KEY_PREFIX,
  type HostEventRecord,
  type OnSleepPayload,
  type ParentToChildEnvelope,
  RUNTIME_CONTRACT_VERSION,
  SHARD_DRAIN_KEY_PREFIX,
  SHARD_REGISTRY_KEY_PREFIX,
  SHARD_REGISTRY_TTL_SECONDS,
  type StorageReadResponsePayload,
  type StorageWriteResponse,
  type ShardRegistration,
  type WakeErrorClass,
  type WakeReason,
  type WsSendResponse,
  createDefaultIdGenerator,
  createDeterministicIdGenerator,
  envelope,
} from "@pax-backend/ipc-protocol";

startPaxNodeTelemetry({ serviceName: "pax-parent-actor", paxZone: "runtime" });

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
const PARENT_METRICS_BIND = parseBind(
  process.env["PAX_PARENT_METRICS_BIND"] ?? "127.0.0.1:7700",
);

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
const PAX_JWT_SECRET = process.env["PAX_JWT_SECRET"] ?? "local-dev-secret";
const PAX_API_GATEWAY_URL =
  process.env["PAX_API_GATEWAY_URL"] ?? "http://127.0.0.1:9081/invoke";
const PAX_TEST_SEED = process.env["PAX_TEST_SEED"];
const STATE_FLUSH_WINDOW_MS = parseNonNegativeInteger(
  process.env["PAX_STATE_FLUSH_WINDOW_MS"] ?? "1000",
  1_000,
);
const TIGRIS_BUCKET =
  process.env["BUCKET_NAME"] ?? process.env["PAX_TIGRIS_BUCKET"] ?? "";
const TIGRIS_REGION = process.env["AWS_REGION"] ?? "auto";
const TIGRIS_ENDPOINT = process.env["AWS_ENDPOINT_URL_S3"];
const LOCAL_TIGRIS_DIR =
  process.env["PAX_LOCAL_TIGRIS_DIR"] ?? join(REPO_ROOT, "var", "tigris-local");
const ALLOWED_PLAYERS_ENFORCE_INTERVAL_MS = Number.parseInt(
  process.env["PAX_ALLOWED_PLAYERS_ENFORCE_INTERVAL_MS"] ?? "5000",
  10,
);
const CPU_MS_PER_TICK_LIMIT = parsePositiveInteger(
  process.env["PAX_CPU_MS_PER_TICK_LIMIT"] ?? "1000",
  1_000,
);
const MEMORY_BYTES_LIMIT = parsePositiveInteger(
  process.env["PAX_MEMORY_BYTES_LIMIT"] ?? "134217728",
  134_217_728,
);
const PROCFS_PAGE_SIZE_BYTES = parsePositiveInteger(
  process.env["PAX_PROCFS_PAGE_SIZE_BYTES"] ?? "4096",
  4_096,
);
const CHILD_MEMORY_LIMIT_MB = Math.max(
  1,
  Math.floor(MEMORY_BYTES_LIMIT / (1024 * 1024)),
);
const BANDWIDTH_BYTES_PER_SEC_LIMIT = parsePositiveInteger(
  process.env["PAX_BANDWIDTH_BYTES_PER_SEC_LIMIT"] ?? "65536",
  65_536,
);
const WS_MESSAGES_PER_SEC_LIMIT = parsePositiveInteger(
  process.env["PAX_WS_MESSAGES_PER_SEC_LIMIT"] ?? "50",
  50,
);
const STATE_BYTES_LIMIT = parsePositiveInteger(
  process.env["PAX_STATE_BYTES_LIMIT"] ?? String(DEFAULT_STATE_BYTES_LIMIT),
  DEFAULT_STATE_BYTES_LIMIT,
);
const BLOB_BYTES_LIMIT = parsePositiveInteger(
  process.env["PAX_BLOB_BYTES_LIMIT"] ?? String(DEFAULT_BLOB_BYTES_LIMIT),
  DEFAULT_BLOB_BYTES_LIMIT,
);
const BLOB_KEYS_LIMIT = parsePositiveInteger(
  process.env["PAX_BLOB_KEYS_LIMIT"] ?? String(DEFAULT_BLOB_KEYS_LIMIT),
  DEFAULT_BLOB_KEYS_LIMIT,
);
const API_INVOCATIONS_PER_MIN_LIMIT = parsePositiveInteger(
  process.env["PAX_API_INVOCATIONS_PER_MIN"] ?? "60",
  60,
);
const CAPACITY_WARNING_RATIO = parseCapacityWarningRatio(
  process.env["PAX_CAPACITY_WARNING_RATIO"] ?? "0.8",
);
const CAPACITY_WARNING_COOLDOWN_MS = parseNonNegativeInteger(
  process.env["PAX_CAPACITY_WARNING_COOLDOWN_MS"] ?? "10000",
  10_000,
);
const SLEEP_MINIMUM_BUDGET_MS = Number.parseInt(
  process.env["PAX_SLEEP_MINIMUM_BUDGET_MS"] ?? "5000",
  10,
);
const SLEEP_GRACE_MS = parseNonNegativeInteger(
  process.env["PAX_SLEEP_GRACE_MS"] ?? "60000",
  60_000,
);
const WAKE_ROLLBACK_FAILURE_THRESHOLD = parsePositiveInteger(
  process.env["PAX_WAKE_ROLLBACK_FAILURE_THRESHOLD"] ?? "3",
  3,
);
const HOST_EVENT_DRAIN_INTERVAL_MS = parsePositiveInteger(
  process.env["PAX_HOST_EVENT_DRAIN_INTERVAL_MS"] ?? "1000",
  1_000,
);
const HOST_EVENT_WAKE_USER_ID = "__pax_host_event__";

const HISTORY_PATH =
  process.env["PAX_HISTORY_PATH"] ?? join(REPO_ROOT, "var", "history.jsonl");
const BUNDLE_DIR = join(REPO_ROOT, "examples", "bundles");
const BUNDLE_CACHE_DIR =
  process.env["PAX_BUNDLE_CACHE_DIR"] ?? join(REPO_ROOT, "var", "bundle-cache");
const BUNDLE_CACHE_MAX_BYTES = parsePositiveInteger(
  process.env["PAX_BUNDLE_CACHE_MAX_BYTES"] ?? "536870912",
  536_870_912,
);
const CHILD_RUNNER_KIND =
  process.env["PAX_CHILD_RUNNER_KIND"] === "noivm" ? "noivm" : "ivm";
const CHILD_RUNNER_ENTRY = join(
  REPO_ROOT,
  "runtime",
  CHILD_RUNNER_KIND === "noivm" ? "child-runner-noivm" : "child-runner-ivm",
  "src",
  "child.mts",
);
const TSX_LOADER_ENTRY = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");

function parseCapacityWarningRatio(raw: string): number {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.8;
}

function parseNonNegativeInteger(raw: string, fallback: number): number {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parsePositiveInteger(raw: string, fallback: number): number {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

interface BindAddress {
  readonly host: string;
  readonly port: number;
}

function parseBind(raw: string): BindAddress {
  const separator = raw.lastIndexOf(":");
  if (separator <= 0) return { host: "127.0.0.1", port: 7700 };
  const host = raw.slice(0, separator);
  const port = Number.parseInt(raw.slice(separator + 1), 10);
  return {
    host: host.length > 0 ? host : "127.0.0.1",
    port: Number.isFinite(port) && port > 0 ? port : 7700,
  };
}

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
const idGenerator =
  PAX_TEST_SEED && PAX_TEST_SEED.length > 0
    ? createDeterministicIdGenerator(`${PAX_TEST_SEED}:${SHARD_ID}`)
    : createDefaultIdGenerator();

// --- Tigris object store -------------------------------------------------

interface ObjectStore {
  readonly kind: "tigris-s3" | "local-dev";
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<readonly ObjectStoreEntry[]>;
}

interface ObjectStoreEntry {
  readonly key: string;
  readonly size: number;
}

class S3ObjectStore implements ObjectStore {
  readonly kind = "tigris-s3" as const;
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    region: string,
    endpoint: string | undefined,
  ) {
    this.client = new S3Client({
      region,
      endpoint,
      forcePathStyle: endpoint !== undefined,
    });
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!result.Body) return new Uint8Array();
      return responseBodyToBytes(result.Body);
    } catch (err) {
      if (isObjectNotFound(err)) return null;
      throw err;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        ContentType: "application/cbor",
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string): Promise<readonly ObjectStoreEntry[]> {
    const entries: ObjectStoreEntry[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const object of result.Contents ?? []) {
        if (!object.Key) continue;
        entries.push({ key: object.Key, size: object.Size ?? 0 });
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
    return entries;
  }
}

class LocalObjectStore implements ObjectStore {
  readonly kind = "local-dev" as const;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async get(key: string): Promise<Uint8Array | null> {
    const path = localObjectPath(this.root, key);
    try {
      return await readFile(path);
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return null;
      throw err;
    }
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const path = localObjectPath(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  async delete(key: string): Promise<void> {
    await rm(localObjectPath(this.root, key), { force: true });
  }

  async list(prefix: string): Promise<readonly ObjectStoreEntry[]> {
    try {
      const info = await stat(this.root);
      if (!info.isDirectory()) return [];
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return [];
      throw err;
    }
    if (prefix.endsWith("/")) {
      const prefixPath = localObjectPath(this.root, prefix);
      try {
        const prefixInfo = await stat(prefixPath);
        if (!prefixInfo.isDirectory()) return [];
      } catch (err) {
        if (isErrnoException(err) && err.code === "ENOENT") return [];
        throw err;
      }
      const entries = await listLocalObjects(this.root, prefixPath);
      return entries.filter((entry) => entry.key.startsWith(prefix));
    }
    const entries = await listLocalObjects(this.root, this.root);
    return entries.filter((entry) => entry.key.startsWith(prefix));
  }
}

const objectStore: ObjectStore =
  TIGRIS_BUCKET.length > 0
    ? new S3ObjectStore(TIGRIS_BUCKET, TIGRIS_REGION, TIGRIS_ENDPOINT)
    : new LocalObjectStore(LOCAL_TIGRIS_DIR);

log.info(
  {
    objectStore: objectStore.kind,
    bucket: TIGRIS_BUCKET || undefined,
    localDir: objectStore.kind === "local-dev" ? LOCAL_TIGRIS_DIR : undefined,
  },
  "parent object store configured",
);

async function responseBodyToBytes(body: unknown): Promise<Uint8Array> {
  if (body && typeof body === "object" && "transformToByteArray" in body) {
    const transformed = await (
      body as { transformToByteArray: () => Promise<Uint8Array> }
    ).transformToByteArray();
    return transformed;
  }
  if (body instanceof Uint8Array) return body;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Tigris object body is not readable");
}

function isObjectNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { readonly name?: unknown; readonly $metadata?: unknown };
  const statusCode = isRecord(candidate.$metadata)
    ? candidate.$metadata["httpStatusCode"]
    : undefined;
  return candidate.name === "NoSuchKey" || statusCode === 404;
}

function localObjectPath(root: string, key: string): string {
  const path = resolve(root, ...key.split("/").filter((part) => part.length > 0));
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`object key escapes local object store root: ${key}`);
  }
  return path;
}

async function listLocalObjects(root: string, path: string): Promise<readonly ObjectStoreEntry[]> {
  const entries: ObjectStoreEntry[] = [];
  const children = await readdir(path, { withFileTypes: true });
  for (const child of children) {
    const childPath = join(path, child.name);
    if (child.isDirectory()) {
      entries.push(...(await listLocalObjects(root, childPath)));
    } else if (child.isFile()) {
      const info = await stat(childPath);
      entries.push({ key: childPath.slice(root.length + 1).split(sep).join("/"), size: info.size });
    }
  }
  return entries;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

// --- Parent metrics -----------------------------------------------------

const parentMetrics = {
  historyEventsTotal: 0,
  historyEventsByName: new Map<string, number>(),
};

// --- History writer -----------------------------------------------------

mkdirSync(dirname(HISTORY_PATH), { recursive: true });
const historyFd = openSync(HISTORY_PATH, "a");
let nextPaxSeq = loadLastPaxSeqForShard(HISTORY_PATH, SHARD_ID) + 1;

interface HistoryFields {
  readonly actorId?: string;
  readonly gameId?: string;
  readonly sessionId?: string;
  readonly playerId?: string;
  readonly runId?: string;
  readonly [key: string]: unknown;
}

function history(event: string, fields: HistoryFields): void {
  const paxSeq = nextPaxSeq;
  nextPaxSeq += 1;
  const line =
    JSON.stringify({
      ...fields,
      ts: new Date().toISOString(),
      shardId: SHARD_ID,
      pax_seq: paxSeq,
      event,
    }) + "\n";
  writeSync(historyFd, line);
  recordHistoryMetric(event);
}

function recordHistoryMetric(event: string): void {
  parentMetrics.historyEventsTotal += 1;
  parentMetrics.historyEventsByName.set(
    event,
    (parentMetrics.historyEventsByName.get(event) ?? 0) + 1,
  );
}

function loadLastPaxSeqForShard(path: string, shardId: string): number {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  const lines = raw.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as {
        readonly shardId?: unknown;
        readonly pax_seq?: unknown;
      };
      if (
        parsed.shardId === shardId &&
        typeof parsed.pax_seq === "number" &&
        Number.isInteger(parsed.pax_seq)
      ) {
        return parsed.pax_seq;
      }
    } catch {
      continue;
    }
  }
  return 0;
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

function recomputeActiveGameCount(): void {
  activeGameCount = Array.from(games.values()).filter((inst) => inst.active).length;
}

function markGameActive(inst: GameInstance): void {
  if (!inst.active) {
    inst.active = true;
    recomputeActiveGameCount();
  }
}

async function registerShard(): Promise<void> {
  const drainRequested =
    (await redis.get(`${SHARD_DRAIN_KEY_PREFIX}${SHARD_ID}`)) === "true";
  const status: ShardRegistration["status"] = drainRequested
    ? activeGameCount === 0
      ? "drained"
      : "draining"
    : "healthy";
  const payload: ShardRegistration & {
    readonly rivet: {
      readonly namespace: string;
      readonly runnerName: string;
      readonly actorName: string;
      readonly adminTokenHint: string;
    };
  } = {
    shardId: SHARD_ID,
    url: SHARD_PUBLIC_URL,
    status,
    healthy: true,
    acceptingWakes: !drainRequested,
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
  readonly origin: "directory" | "object-store" | "local-example";
  readonly contentSha256?: string;
}

const bundleCache = new Map<string, LoadedBundle>();

async function loadBundle(bundleName: string): Promise<LoadedBundle> {
  const cached = bundleCache.get(bundleName);
  if (cached?.origin === "directory") return cached;
  const bundleRaw = await redis.get(`${BUNDLE_KEY_PREFIX}${bundleName}`);
  if (bundleRaw) {
    const bundle = JSON.parse(bundleRaw) as BundleRecord;
    if (typeof bundle.source === "string" && bundle.source.length > 0) {
      const record: LoadedBundle = {
        name: bundleName,
        source: bundle.source,
        manifest: bundle.manifest,
        origin: "directory",
        contentSha256: sha256String(bundle.source),
      };
      bundleCache.set(bundleName, record);
      return record;
    }
    if (bundle.sourceObjectKey || bundle.tigrisPath) {
      const record = await loadObjectBackedBundle(bundle);
      bundleCache.set(bundleName, record);
      return record;
    }
  }
  if (cached) return cached;
  return loadLocalExampleBundle(bundleName);
}

async function loadObjectBackedBundle(bundle: BundleRecord): Promise<LoadedBundle> {
  const sourceObjectKey = bundle.sourceObjectKey ?? `${bundle.tigrisPath ?? ""}source.js`;
  if (!sourceObjectKey || sourceObjectKey === "source.js") {
    throw new Error(`bundle ${bundle.bundleName} is missing source object metadata`);
  }
  const expectedSha = bundle.contentSha256;
  const cached = await readCachedBundleSource(bundle.bundleName, expectedSha);
  if (cached) {
    return {
      name: bundle.bundleName,
      source: cached,
      manifest: bundle.manifest,
      origin: "object-store",
      contentSha256: expectedSha,
    };
  }
  const bytes = await objectStore.get(sourceObjectKey);
  if (bytes === null) {
    throw new Error(`bundle source object not found: ${sourceObjectKey}`);
  }
  const source = Buffer.from(bytes).toString("utf8");
  const actualSha = sha256String(source);
  if (expectedSha && actualSha !== expectedSha) {
    throw new Error(
      `bundle ${bundle.bundleName} sha256 mismatch: expected ${expectedSha}, got ${actualSha}`,
    );
  }
  await writeCachedBundleSource(bundle.bundleName, source);
  return {
    name: bundle.bundleName,
    source,
    manifest: bundle.manifest,
    origin: "object-store",
    contentSha256: actualSha,
  };
}

async function readCachedBundleSource(
  bundleName: string,
  expectedSha: string | undefined,
): Promise<string | undefined> {
  try {
    const path = bundleCacheSourcePath(bundleName);
    const source = await readFile(path, "utf8");
    if (!expectedSha || sha256String(source) === expectedSha) {
      const now = new Date();
      await utimes(path, now, now);
      return source;
    }
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return undefined;
    throw err;
  }
  return undefined;
}

async function writeCachedBundleSource(bundleName: string, source: string): Promise<void> {
  const path = bundleCacheSourcePath(bundleName);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, "utf8");
  await pruneBundleCache();
}

function bundleCacheSourcePath(bundleName: string): string {
  return localObjectPath(BUNDLE_CACHE_DIR, `${bundleName}/source.js`);
}

interface CacheFileEntry {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

async function pruneBundleCache(): Promise<void> {
  const files = await listCacheFiles(resolve(BUNDLE_CACHE_DIR));
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= BUNDLE_CACHE_MAX_BYTES) return;
  for (const file of Array.from(files).sort(
    (a: CacheFileEntry, b: CacheFileEntry) => a.mtimeMs - b.mtimeMs,
  )) {
    if (total <= BUNDLE_CACHE_MAX_BYTES) return;
    await rm(file.path, { force: true });
    total -= file.size;
  }
}

async function listCacheFiles(root: string): Promise<readonly CacheFileEntry[]> {
  try {
    const info = await stat(root);
    if (!info.isDirectory()) return [];
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") return [];
    throw err;
  }
  const entries: CacheFileEntry[] = [];
  for (const child of await readdir(root, { withFileTypes: true })) {
    const childPath = join(root, child.name);
    if (child.isDirectory()) {
      entries.push(...(await listCacheFiles(childPath)));
    } else if (child.isFile()) {
      const info = await stat(childPath);
      entries.push({ path: childPath, size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  return entries;
}

function loadLocalExampleBundle(bundleName: string): LoadedBundle {
  const compiledPath = join(BUNDLE_DIR, bundleName, "dist", "bundle.js");
  const source = readFileSync(compiledPath, "utf8");
  const manifest = extractManifestFromSource(source);
  const record: LoadedBundle = {
    name: bundleName,
    source,
    manifest,
    origin: "local-example",
    contentSha256: sha256String(source),
  };
  bundleCache.set(bundleName, record);
  return record;
}

function sha256String(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
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

function bundleAcceptsBlobCompatTag(
  manifest: BundleRecord["manifest"],
  blobCompatTag: string | undefined,
): boolean {
  return blobCompatTag === undefined || manifest.compatTagsAccepted.includes(blobCompatTag);
}

// --- Per-game state ----------------------------------------------------

interface SessionRecord {
  readonly ws: WsLike;
  readonly sessionId: string;
  readonly playerId: string;
  readonly connectedAt: number;
  readonly traceId: string;
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
  bundle: LoadedBundle;
  bundleName: string;
  bundleCompatTag: string;
  blobCompatTag?: string;
  nextWakeReason?: WakeReason;
  nextWakeErrorClass?: WakeErrorClass;
  readonly runId: string;
  active: boolean;
  child: ChildProcess | null;
  intentionalChildStop?: {
    readonly child: ChildProcess;
    readonly reason: "sleepComplete" | "sleepDeadline" | "replacementRestart";
  };
  readonly sessions: Map<string, SessionRecord>;
  readonly wsUsageSamples: UsageSample[];
  readonly apiInvokeSamples: UsageSample[];
  readonly capacityWarningSentAt: Map<ComputeBudgetName, number>;
  stateBytes: number;
  stateLoaded: boolean;
  stateFound: boolean;
  stateValue?: unknown;
  stateDirty: boolean;
  stateRevision: number;
  stateDurableRevision: number;
  stateFlushTimer: NodeJS.Timeout | null;
  stateFlushPromise: Promise<StateFlushOutcome> | null;
  blobBytes: number;
  blobKeys: number;
  lastHandlerDurationMs: number;
  ready: boolean;
  bootstrapPromise: Promise<void> | null;
  sleepGraceTimer: NodeJS.Timeout | null;
  sleepTimer: NodeJS.Timeout | null;
}

interface StateFlushOutcome {
  readonly response: StorageWriteResponse;
  readonly byteSize: number;
  readonly flushed: boolean;
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

function startMetricsServer(bind: BindAddress): void {
  const server = createServer((req, res) => {
    handleMetricsRequest(req, res);
  });
  server.on("error", (err: Error) => {
    log.warn({ host: bind.host, port: bind.port, err: err.message }, "metrics server error");
  });
  server.listen(bind.port, bind.host, () => {
    log.info({ host: bind.host, port: bind.port }, "parent metrics server listening");
  });
}

function handleMetricsRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    writeHttpJson(res, 200, { status: "ok", runtime: "parent-actor", shardId: SHARD_ID });
    return;
  }
  if (req.method === "GET" && url.pathname === "/metrics") {
    writeHttpText(res, 200, parentMetricsText());
    return;
  }
  writeHttpJson(res, 404, { ok: false, error: "notFound" });
}

function writeHttpJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

function writeHttpText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function parentMetricsText(): string {
  const lines = [
    "# HELP pax_parent_active_games Active games in this parent actor process.",
    "# TYPE pax_parent_active_games gauge",
    `pax_parent_active_games ${games.size}`,
    "# HELP pax_parent_active_sessions Active websocket sessions in this parent actor process.",
    "# TYPE pax_parent_active_sessions gauge",
    `pax_parent_active_sessions ${activeSessionCount()}`,
    "# HELP pax_parent_child_processes Active child runner processes in this parent actor process.",
    "# TYPE pax_parent_child_processes gauge",
    `pax_parent_child_processes ${activeChildProcessCount()}`,
    "# HELP pax_parent_history_events_written_total History events written by this parent process.",
    "# TYPE pax_parent_history_events_written_total counter",
    `pax_parent_history_events_written_total ${parentMetrics.historyEventsTotal}`,
    "# HELP pax_parent_history_events_by_type_total History events written by event type.",
    "# TYPE pax_parent_history_events_by_type_total counter",
  ];
  for (const [event, count] of Array.from(parentMetrics.historyEventsByName.entries()).sort()) {
    lines.push(
      `pax_parent_history_events_by_type_total{event="${prometheusLabel(event)}"} ${count}`,
    );
  }
  lines.push(
    "# HELP pax_parent_build_info Parent actor static build/runtime labels.",
    "# TYPE pax_parent_build_info gauge",
    `pax_parent_build_info{${parentBuildLabels()}} 1`,
  );
  return `${lines.join("\n")}\n`;
}

function activeSessionCount(): number {
  let count = 0;
  for (const inst of games.values()) {
    count += inst.sessions.size;
  }
  return count;
}

function activeChildProcessCount(): number {
  let count = 0;
  for (const inst of games.values()) {
    if (inst.child) count += 1;
  }
  return count;
}

function parentBuildLabels(): string {
  return [
    `shard_id="${prometheusLabel(SHARD_ID)}"`,
    `runtime_contract_min="${RUNTIME_CONTRACTS_SUPPORTED[0]}"`,
    `runtime_contract_max="${RUNTIME_CONTRACTS_SUPPORTED[1]}"`,
  ].join(",");
}

function prometheusLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

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
  bundle: LoadedBundle,
  blobCompatTag?: string,
): GameInstance {
  const existing = games.get(actorId);
  if (existing) {
    markGameActive(existing);
    return existing;
  }
  const runId = idGenerator.generateRunId();
  const inst: GameInstance = {
    actorId,
    gameId,
    bundle,
    bundleName: bundle.name,
    bundleCompatTag: bundle.manifest.compatTagProduced,
    blobCompatTag,
    runId,
    active: true,
    child: null,
    sessions: new Map(),
    wsUsageSamples: [],
    apiInvokeSamples: [],
    capacityWarningSentAt: new Map(),
    stateBytes: 0,
    stateLoaded: false,
    stateFound: false,
    stateDirty: false,
    stateRevision: 0,
    stateDurableRevision: 0,
    stateFlushTimer: null,
    stateFlushPromise: null,
    blobBytes: 0,
    blobKeys: 0,
    lastHandlerDurationMs: 0,
    ready: false,
    bootstrapPromise: null,
    sleepGraceTimer: null,
    sleepTimer: null,
  };
  games.set(actorId, inst);
  recomputeActiveGameCount();
  history("game.created", {
    actorId,
    gameId,
    bundleName: bundle.name,
    bundleOrigin: bundle.origin,
    runId,
  });
  return inst;
}

function cancelSleepGrace(inst: GameInstance, cause: string): void {
  if (!inst.sleepGraceTimer) return;
  clearTimeout(inst.sleepGraceTimer);
  inst.sleepGraceTimer = null;
  history("lifecycle.sleepGrace.cancelled", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    runId: inst.runId,
    cause,
  });
}

function scheduleIdleSleepGrace(inst: GameInstance): void {
  if (inst.sessions.size > 0 || inst.sleepGraceTimer || inst.sleepTimer) return;
  const deadline = Date.now() + SLEEP_GRACE_MS;
  history("lifecycle.sleepGrace.started", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    runId: inst.runId,
    delayMs: SLEEP_GRACE_MS,
    deadline,
  });

  const expire = (): void => {
    inst.sleepGraceTimer = null;
    if (inst.sessions.size > 0 || inst.sleepTimer) return;
    history("lifecycle.sleepGrace.expired", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      deadline,
    });
    sendOnSleep(inst, "idle");
  };

  if (SLEEP_GRACE_MS === 0) {
    expire();
    return;
  }

  inst.sleepGraceTimer = setTimeout(expire, SLEEP_GRACE_MS);
  inst.sleepGraceTimer.unref();
}

async function writeActiveGameDirectory(inst: GameInstance): Promise<void> {
  try {
    await redis.set(
      `${ACTIVE_GAMES_KEY_PREFIX}${inst.gameId}`,
      JSON.stringify({
        gameId: inst.gameId,
        shardId: SHARD_ID,
        actorId: inst.actorId,
        placedAt: Date.now(),
        refreshedAt: Date.now(),
        generation: 1,
      }),
      "EX",
      ACTIVE_GAME_TTL_SECONDS,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ gameId: inst.gameId, err: msg }, "active_games set failed");
  }
}

async function releaseActiveGame(
  inst: GameInstance,
  reason: OnSleepPayload["reason"],
): Promise<void> {
  cancelSleepGrace(inst, "release");
  if (inst.stateFlushTimer) {
    clearTimeout(inst.stateFlushTimer);
    inst.stateFlushTimer = null;
  }
  inst.active = false;
  inst.nextWakeReason = "cold-restart-from-storage";
  inst.stateLoaded = false;
  inst.stateFound = false;
  inst.stateValue = undefined;
  inst.stateDirty = false;
  inst.stateFlushTimer = null;
  recomputeActiveGameCount();
  try {
    await redis.del(`${ACTIVE_GAMES_KEY_PREFIX}${inst.gameId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ gameId: inst.gameId, err: msg }, "active_games delete failed");
  }
  history("game.released", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    runId: inst.runId,
    reason,
  });
}

function forkChild(inst: GameInstance): Promise<void> {
  if (inst.bootstrapPromise) return inst.bootstrapPromise;
  inst.bootstrapPromise = new Promise<void>((resolveReady, rejectReady) => {
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
      if (inst.sleepTimer) {
        clearTimeout(inst.sleepTimer);
        inst.sleepTimer = null;
      }
      const wasCurrentChild = inst.child === child;
      const intentionalStop =
        inst.intentionalChildStop?.child === child
          ? inst.intentionalChildStop.reason
          : undefined;
      if (intentionalStop) inst.intentionalChildStop = undefined;
      history("child.exit", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        runId: inst.runId,
        code,
        signal,
        intentional: intentionalStop !== undefined,
        stopReason: intentionalStop,
      });
      if (wasCurrentChild) {
        inst.ready = false;
        inst.child = null;
        inst.bootstrapPromise = null;
      }
      if (wasCurrentChild && !intentionalStop) {
        void restartChildAfterCrash(inst, code, signal);
      }
    });

    child.on("message", (raw: unknown) => {
      handleChildIpc(inst, raw);
    });

    child.on("error", (err: Error) => {
      log.error({ actorId: inst.actorId, err: err.message }, "child error");
      rejectReady(err);
    });

    // One-shot ready watcher; remove itself once the child runtime has loaded
    // the bundle. Host events are not drained until onWake has been sent.
    const readyHandler = (raw: unknown): void => {
      if (!isChildEnvelope(raw) || raw.type !== CHILD_TO_PARENT.ready) return;
      child.off("message", readyHandler);
      void sendWakeAfterHydration(child, inst, resolveReady, rejectReady);
    };
    child.on("message", readyHandler);

    sendTyped(child, "bootstrap", {
      bundleName: inst.bundleName,
      bundleSource: inst.bundle.source,
      bundleCompatTag: inst.bundleCompatTag,
      runId: inst.runId,
      gameId: inst.gameId,
      memoryLimitMb: CHILD_MEMORY_LIMIT_MB,
      handlerTimeoutMs: CPU_MS_PER_TICK_LIMIT,
      testSeed: PAX_TEST_SEED,
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
    const state = await readGameStorage(inst, "state");
    await refreshBlobUsage(inst);
    const reason =
      inst.nextWakeReason ??
      (inst.blobCompatTag && inst.blobCompatTag !== inst.bundleCompatTag
        ? "upgrade"
        : "cold-start");
    const errorClass =
      reason === "cold-restart-after-crash" ? inst.nextWakeErrorClass : undefined;
    sendTyped(child, "onWake", {
      reason,
      errorClass,
      runId: inst.runId,
      bundleName: inst.bundleName,
      bundleCompatTag: inst.bundleCompatTag,
      blobCompatTag: inst.blobCompatTag,
      state: state.found ? state.value : undefined,
    });
    history("onWake.sent", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      reason,
      errorClass,
      bundleName: inst.bundleName,
      bundleCompatTag: inst.bundleCompatTag,
      stateBytes: state.bytes,
      blobBytes: inst.blobBytes,
      blobKeys: inst.blobKeys,
      blobCompatTag: inst.blobCompatTag,
    });
    inst.ready = true;
    inst.nextWakeReason = undefined;
    inst.nextWakeErrorClass = undefined;
    resolveReady();
    void drainHostEvents(inst);
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
      void handleStateFlush(inst, raw.requestId);
      return;
    case CHILD_TO_PARENT.blobPut:
      void handleBlobPut(inst, raw.requestId, raw.payload);
      return;
    case CHILD_TO_PARENT.blobGet:
      void handleBlobGet(inst, raw.requestId, raw.payload);
      return;
    case CHILD_TO_PARENT.blobDelete:
      void handleBlobDelete(inst, raw.requestId, raw.payload);
      return;
    case CHILD_TO_PARENT.blobList:
      void handleBlobList(inst, raw.requestId, raw.payload);
      return;
    case CHILD_TO_PARENT.wsSend:
      handleWsSend(inst, raw.requestId, raw.payload);
      return;
    case CHILD_TO_PARENT.wsSendRejected:
      history("ws.send.rejected", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        runId: inst.runId,
        error: raw.payload.error,
        detail: raw.payload.detail,
      });
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
      handleLifecycleRequestSleep(inst);
      return;
    case CHILD_TO_PARENT.lifecycleSleepComplete:
      void handleLifecycleSleepComplete(inst, raw.payload);
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
      handleChildHandlerError(inst, raw.payload);
      return;
    case "child.handlerComplete":
      handleChildHandlerComplete(inst, raw.payload);
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

async function drainHostEvents(inst: GameInstance): Promise<void> {
  if (!inst.child || !inst.ready) return;
  const key = `${HOST_EVENT_QUEUE_KEY_PREFIX}${inst.gameId}`;
  for (let drained = 0; drained < 100; drained += 1) {
    const raw = await redis.lpop(key);
    if (!raw) return;
    let record: HostEventRecord;
    try {
      record = JSON.parse(raw) as HostEventRecord;
    } catch (err) {
      history("onHostEvent.dropped", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        reason: "badQueueRecord",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (record.expiresAt <= Date.now()) {
      history("onHostEvent.dropped", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        eventId: record.eventId,
        eventType: record.eventType,
        reason: "expired",
      });
      continue;
    }
    deliverHostEvent(inst, record);
  }
}

function deliverHostEvent(inst: GameInstance, record: HostEventRecord): void {
  if (!inst.child) return;
  const deliveryAttempts = record.deliveryAttempts + 1;
  sendTyped(inst.child, "onHostEvent", {
    eventId: record.eventId,
    eventType: record.eventType,
    payload: record.payload,
    receivedAt: record.receivedAt,
    deliveryAttempts,
  });
  history("onHostEvent.delivered", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    runId: inst.runId,
    eventId: record.eventId,
    eventType: record.eventType,
    payload: record.payload,
    wakeOnDelivery: record.wakeOnDelivery,
    receivedAt: record.receivedAt,
    deliveryAttempts,
  });
}

function startHostEventDrainLoop(): void {
  const timer = setInterval(() => {
    for (const inst of games.values()) {
      void drainHostEvents(inst).catch((err: unknown) => {
        history("onHostEvent.drainError", {
          actorId: inst.actorId,
          gameId: inst.gameId,
          runId: inst.runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }, HOST_EVENT_DRAIN_INTERVAL_MS);
  timer.unref();
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
  maybeSendCapacityWarnings(inst, budget);
  if (inst.child) {
    sendTyped(inst.child, "compute.budget.response", { budget }, requestId);
  }
}

function handleChildHandlerError(
  inst: GameInstance,
  payload: ChildHandlerErrorPayload,
): void {
  inst.lastHandlerDurationMs = payload.durationMs;
  history("child.handlerError", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    runId: inst.runId,
    ...payload,
  });
  if (payload.code === "handlerTimeout") {
    history("compute.budget.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      budget: "cpu-ms-per-tick",
      handler: payload.handler,
      currentUsage: payload.durationMs,
      limit: payload.timeoutMs,
      reason: "handlerTimeout",
    });
  }
  if (payload.handler === "onWake") {
    history("onWake.failed", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      bundleName: inst.bundleName,
      bundleCompatTag: inst.bundleCompatTag,
      code: payload.code,
      error: payload.error,
      durationMs: payload.durationMs,
      rollbackFailureThreshold: WAKE_ROLLBACK_FAILURE_THRESHOLD,
    });
    void handleWakeFailureRollback(inst);
  }
  log.warn({ actorId: inst.actorId, ...payload }, "child handler error");
}

function handleChildHandlerComplete(
  inst: GameInstance,
  payload: ChildHandlerCompletePayload,
): void {
  inst.lastHandlerDurationMs = payload.durationMs;
  history("child.handlerComplete", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    runId: inst.runId,
    ...payload,
  });
  if (payload.handler === "onWake") {
    history("onWake.succeeded", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      bundleName: inst.bundleName,
      bundleCompatTag: inst.bundleCompatTag,
      durationMs: payload.durationMs,
    });
    void resetWakeRollbackFailures(inst);
  }
  maybeSendCapacityWarnings(inst);
}

async function handleWakeFailureRollback(inst: GameInstance): Promise<void> {
  try {
    const game = await readGameRecord(inst.gameId);
    const rollback = game?.bundleRollback;
    if (!game || !rollback || rollback.failedBundleName !== inst.bundleName) return;

    const now = Date.now();
    const consecutiveWakeFailures = rollback.consecutiveWakeFailures + 1;
    if (now > rollback.expiresAt) {
      await writeGameRecord({ ...game, bundleRollback: undefined });
      history("bundle.rollback.expired", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        runId: inst.runId,
        bundleName: rollback.previousBundleName,
        failedBundleName: rollback.failedBundleName,
        consecutiveWakeFailures,
        rollbackBackupCreatedAt: rollback.createdAt,
        rollbackBackupExpiresAt: rollback.expiresAt,
      });
      return;
    }

    const updatedRollback = { ...rollback, consecutiveWakeFailures };
    if (consecutiveWakeFailures < WAKE_ROLLBACK_FAILURE_THRESHOLD) {
      const retryBundle = inst.bundle;
      await writeGameRecord({ ...game, bundleRollback: updatedRollback });
      history("bundle.rollback.pending", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        runId: inst.runId,
        bundleName: rollback.previousBundleName,
        failedBundleName: rollback.failedBundleName,
        consecutiveWakeFailures,
        rollbackFailureThreshold: WAKE_ROLLBACK_FAILURE_THRESHOLD,
        rollbackBackupExpiresAt: rollback.expiresAt,
      });
      await restartChildWithBundle(inst, retryBundle, game.blobCompatTag, "retryFailedBundle");
      return;
    }

    history("bundle.rollback.thresholdReached", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      bundleName: rollback.previousBundleName,
      failedBundleName: rollback.failedBundleName,
      consecutiveWakeFailures,
      rollbackFailureThreshold: WAKE_ROLLBACK_FAILURE_THRESHOLD,
      rollbackBackupExpiresAt: rollback.expiresAt,
    });
    const rollbackBundle = await loadBundle(rollback.previousBundleName);
    if (!bundleAcceptsBlobCompatTag(rollbackBundle.manifest, game.blobCompatTag)) {
      await writeGameRecord({ ...game, bundleRollback: updatedRollback });
      history("bundle.rollback.rejected", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        runId: inst.runId,
        bundleName: rollback.previousBundleName,
        failedBundleName: rollback.failedBundleName,
        blobCompatTag: game.blobCompatTag,
        bundleCompatTagsAccepted: rollbackBundle.manifest.compatTagsAccepted,
        consecutiveWakeFailures,
      });
      return;
    }

    await writeGameRecord({
      ...game,
      bundleName: rollback.previousBundleName,
      bundleRollback: undefined,
    });
    history("bundle.rollback", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      bundleName: rollback.previousBundleName,
      failedBundleName: rollback.failedBundleName,
      failedBundleCompatTag: inst.bundleCompatTag,
      consecutiveWakeFailures,
      rollbackFailureThreshold: WAKE_ROLLBACK_FAILURE_THRESHOLD,
      rollbackBackupCreatedAt: rollback.createdAt,
      rollbackBackupExpiresAt: rollback.expiresAt,
    });
    await restartChildWithBundle(inst, rollbackBundle, game.blobCompatTag, "rollbackBundle");
  } catch (err) {
    history("bundle.rollback.error", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      bundleName: inst.bundleName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function resetWakeRollbackFailures(inst: GameInstance): Promise<void> {
  try {
    const game = await readGameRecord(inst.gameId);
    const rollback = game?.bundleRollback;
    if (!game || !rollback || rollback.failedBundleName !== inst.bundleName) return;
    if (rollback.consecutiveWakeFailures === 0) return;
    await writeGameRecord({
      ...game,
      bundleRollback: { ...rollback, consecutiveWakeFailures: 0 },
    });
    history("bundle.rollback.failureCountReset", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      bundleName: rollback.previousBundleName,
      failedBundleName: rollback.failedBundleName,
      previousConsecutiveWakeFailures: rollback.consecutiveWakeFailures,
    });
  } catch (err) {
    history("bundle.rollback.failureCountReset.error", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      bundleName: inst.bundleName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function restartChildWithBundle(
  inst: GameInstance,
  bundle: LoadedBundle,
  blobCompatTag: string | undefined,
  reason: "retryFailedBundle" | "rollbackBundle",
): Promise<void> {
  const previousChild = inst.child;
  inst.bundle = bundle;
  inst.bundleName = bundle.name;
  inst.bundleCompatTag = bundle.manifest.compatTagProduced;
  inst.blobCompatTag = blobCompatTag;
  inst.ready = false;
  inst.child = null;
  inst.bootstrapPromise = null;
  if (previousChild) {
    inst.intentionalChildStop = { child: previousChild, reason: "replacementRestart" };
    if (!previousChild.killed) previousChild.kill("SIGTERM");
  }
  history("bundle.rollback.restart", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    runId: inst.runId,
    bundleName: bundle.name,
    bundleCompatTag: bundle.manifest.compatTagProduced,
    blobCompatTag,
    reason,
  });
  await forkChild(inst);
}

async function restartChildAfterCrash(
  inst: GameInstance,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  inst.nextWakeReason = "cold-restart-after-crash";
  inst.nextWakeErrorClass = classifyChildExit(code, signal);
  history("child.restart", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    runId: inst.runId,
    reason: inst.nextWakeReason,
    errorClass: inst.nextWakeErrorClass,
    code,
    signal,
    bundleName: inst.bundleName,
    bundleCompatTag: inst.bundleCompatTag,
  });
  try {
    await forkChild(inst);
  } catch (err) {
    history("child.restart.failed", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      reason: "cold-restart-after-crash",
      bundleName: inst.bundleName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function classifyChildExit(
  code: number | null,
  signal: NodeJS.Signals | null,
): WakeErrorClass {
  if (signal === "SIGKILL") return "oom";
  if (signal || code === null) return "unknown";
  return code === 0 ? "unknown" : "crash";
}

async function readGameRecord(gameId: string): Promise<GameRecord | undefined> {
  const raw = await redis.get(`${GAME_KEY_PREFIX}${gameId}`);
  return raw ? (JSON.parse(raw) as GameRecord) : undefined;
}

async function writeGameRecord(game: GameRecord): Promise<void> {
  await redis.set(`${GAME_KEY_PREFIX}${game.gameId}`, JSON.stringify(game));
}

async function refreshBundleForWake(inst: GameInstance): Promise<boolean> {
  const game = await readGameRecord(inst.gameId);
  if (!game) return true;
  const blobCompatTag = game.blobCompatTag;
  if (inst.bundleName === game.bundleName && inst.blobCompatTag === blobCompatTag) {
    return true;
  }

  const bundle =
    inst.bundleName === game.bundleName ? inst.bundle : await loadBundle(game.bundleName);
  if (!bundleAcceptsBlobCompatTag(bundle.manifest, blobCompatTag)) {
    history("bundle.coldWake.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      bundleName: game.bundleName,
      bundleCompatTag: bundle.manifest.compatTagProduced,
      error: "compatTagOutOfRange",
      blobCompatTag,
      bundleCompatTagsAccepted: bundle.manifest.compatTagsAccepted,
    });
    return false;
  }

  const previousBundleName = inst.bundleName;
  const previousBundleCompatTag = inst.bundleCompatTag;
  inst.bundle = bundle;
  inst.bundleName = bundle.name;
  inst.bundleCompatTag = bundle.manifest.compatTagProduced;
  inst.blobCompatTag = blobCompatTag;
  if (previousBundleName !== bundle.name && inst.nextWakeReason === "cold-restart-from-storage") {
    inst.nextWakeReason = undefined;
  }
  history("bundle.refreshedForWake", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    runId: inst.runId,
    previousBundleName,
    previousBundleCompatTag,
    bundleName: bundle.name,
    bundleCompatTag: bundle.manifest.compatTagProduced,
    blobCompatTag,
  });
  return true;
}

function handleLifecycleRequestSleep(inst: GameInstance): void {
  history("lifecycle.requestSleep", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    runId: inst.runId,
  });
  sendOnSleep(inst, "requestedBySleep");
}

async function handleLifecycleSleepComplete(
  inst: GameInstance,
  payload: Extract<ChildToParentEnvelope, { type: "lifecycle.sleepComplete" }>["payload"],
): Promise<void> {
  if (inst.sleepTimer) {
    clearTimeout(inst.sleepTimer);
    inst.sleepTimer = null;
  }
  try {
    const flush = await flushStateCache(inst);
    history("state.flush.plannedTransition", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      reason: payload.reason,
      ok: flush.response.ok,
      byteSize: flush.byteSize,
      error: flush.response.ok ? undefined : flush.response.error,
    });
    if (!flush.response.ok) {
      history("lifecycle.sleepComplete.error", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        runId: inst.runId,
        reason: payload.reason,
        error: flush.response.error,
        detail: flush.response.detail,
      });
      return;
    }
    inst.blobCompatTag = inst.bundleCompatTag;
    const raw = await redis.get(`${GAME_KEY_PREFIX}${inst.gameId}`);
    if (raw) {
      const game = JSON.parse(raw) as GameRecord;
      const updated: GameRecord = {
        ...game,
        blobCompatTag: inst.bundleCompatTag,
      };
      await redis.set(`${GAME_KEY_PREFIX}${inst.gameId}`, JSON.stringify(updated));
    }
    history("lifecycle.sleepComplete", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      reason: payload.reason,
      deadline: payload.deadline,
      bundleName: inst.bundleName,
      blobCompatTag: inst.bundleCompatTag,
    });
    await releaseActiveGame(inst, payload.reason);
  } catch (err) {
    history("lifecycle.sleepComplete.error", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      reason: payload.reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (inst.child) {
    inst.intentionalChildStop = { child: inst.child, reason: "sleepComplete" };
    inst.child.kill();
  }
}

function sendOnSleep(
  inst: GameInstance,
  reason: OnSleepPayload["reason"],
): void {
  cancelSleepGrace(inst, "onSleep");
  if (!inst.child) {
    history("onSleep.skipped", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      reason,
      cause: "childMissing",
    });
    if (reason === "idle") {
      void releaseActiveGame(inst, reason);
    }
    return;
  }
  if (inst.sleepTimer) {
    history("onSleep.skipped", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      reason,
      cause: "alreadySleeping",
    });
    return;
  }
  const configuredBudgetMs = Number.isFinite(SLEEP_MINIMUM_BUDGET_MS)
    ? SLEEP_MINIMUM_BUDGET_MS
    : 5_000;
  const budgetMs = Math.max(1_000, configuredBudgetMs);
  const deadline = Date.now() + budgetMs;
  sendTyped(inst.child, "onSleep", { deadline, reason });
  history("onSleep.sent", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    runId: inst.runId,
    reason,
    deadline,
    budgetMs,
  });
  inst.sleepTimer = setTimeout(() => {
    void handleOnSleepDeadline(inst, reason, deadline);
  }, budgetMs);
  inst.sleepTimer.unref();
}

async function handleOnSleepDeadline(
  inst: GameInstance,
  reason: OnSleepPayload["reason"],
  deadline: number,
): Promise<void> {
  inst.sleepTimer = null;
  history("onSleep.deadline", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    runId: inst.runId,
    reason,
    deadline,
  });
  const flush = await flushStateCache(inst);
  history("state.flush.plannedTransition", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    runId: inst.runId,
    reason: `${reason}:deadline`,
    ok: flush.response.ok,
    byteSize: flush.byteSize,
    error: flush.response.ok ? undefined : flush.response.error,
  });
  if (!flush.response.ok) {
    history("onSleep.deadline.storageUnavailable", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      reason,
      deadline,
      error: flush.response.error,
      detail: flush.response.detail,
    });
    return;
  }
  await releaseActiveGame(inst, reason);
  if (inst.child) {
    inst.intentionalChildStop = { child: inst.child, reason: "sleepDeadline" };
    inst.child.kill();
  }
}

async function handleStorageRead(
  inst: GameInstance,
  requestId: string | undefined,
  tier: "state",
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
  sendTyped(inst.child, "state.read.response", response, requestId);
}

async function handleStorageWrite(
  inst: GameInstance,
  requestId: string | undefined,
  tier: "state",
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
  sendTyped(inst.child, "state.write.response", { response }, requestId);
}

async function handleBlobPut(
  inst: GameInstance,
  requestId: string | undefined,
  payload: Extract<ChildToParentEnvelope, { type: "blob.put" }>["payload"],
): Promise<void> {
  if (!requestId) {
    history("blob.put.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      key: payload.key,
      error: "missingRequestId",
    });
    return;
  }
  const keyCheck = validateBlobKey(payload.key);
  if (!keyCheck.ok) {
    const response: StorageWriteResponse = {
      ok: false,
      error: "storageUnavailable",
      detail: { message: keyCheck.message },
    };
    history("blob.put.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      requestId,
      key: payload.key,
      error: response.error,
      detail: response.detail,
    });
    if (inst.child) sendTyped(inst.child, "blob.put.response", { response }, requestId);
    return;
  }
  const bytes = decodeBase64(payload.bytesBase64);
  const budget = await prospectiveBlobBudget(inst, keyCheck.key, bytes.byteLength);
  if (!budget.ok) {
    const response: StorageWriteResponse = {
      ok: false,
      error: budget.error,
      detail: budget.detail,
    };
    history("blob.put.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      requestId,
      key: keyCheck.key,
      error: response.error,
      detail: response.detail,
    });
    if (inst.child) sendTyped(inst.child, "blob.put.response", { response }, requestId);
    maybeSendCapacityWarnings(inst);
    return;
  }
  let response: StorageWriteResponse = { ok: true };
  try {
    await objectStore.put(blobObjectKey(inst.gameId, keyCheck.key), bytes);
    inst.blobBytes = budget.totalBytes;
    inst.blobKeys = budget.totalKeys;
    history("blob.put", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      requestId,
      key: keyCheck.key,
      byteSize: bytes.byteLength,
      blobBytes: inst.blobBytes,
      blobKeys: inst.blobKeys,
      ok: true,
    });
  } catch (err) {
    response = {
      ok: false,
      error: "storageUnavailable",
      detail: { message: err instanceof Error ? err.message : String(err) },
    };
    history("blob.put.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      requestId,
      key: keyCheck.key,
      error: response.error,
      detail: response.detail,
    });
  }
  maybeSendCapacityWarnings(inst);
  if (inst.child) sendTyped(inst.child, "blob.put.response", { response }, requestId);
}

async function handleBlobGet(
  inst: GameInstance,
  requestId: string | undefined,
  payload: Extract<ChildToParentEnvelope, { type: "blob.get" }>["payload"],
): Promise<void> {
  if (!requestId) {
    history("blob.get.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      key: payload.key,
      error: "missingRequestId",
    });
    return;
  }
  const keyCheck = validateBlobKey(payload.key);
  if (!keyCheck.ok) {
    history("blob.get.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      requestId,
      key: payload.key,
      error: "storageUnavailable",
      detail: { message: keyCheck.message },
    });
    if (inst.child) {
      sendTyped(inst.child, "blob.get.response", { found: false, bytes: 0 }, requestId);
    }
    return;
  }
  try {
    const bytes = await objectStore.get(blobObjectKey(inst.gameId, keyCheck.key));
    const response =
      bytes === null
        ? { found: false as const, bytes: 0 }
        : {
            found: true as const,
            bytesBase64: Buffer.from(bytes).toString("base64"),
            bytes: bytes.byteLength,
          };
    history("blob.get", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      requestId,
      key: keyCheck.key,
      found: response.found,
      byteSize: response.bytes,
    });
    if (inst.child) sendTyped(inst.child, "blob.get.response", response, requestId);
  } catch (err) {
    history("blob.get.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      requestId,
      key: keyCheck.key,
      error: "storageUnavailable",
      detail: { message: err instanceof Error ? err.message : String(err) },
    });
    if (inst.child) {
      sendTyped(inst.child, "blob.get.response", { found: false, bytes: 0 }, requestId);
    }
  }
}

async function handleBlobDelete(
  inst: GameInstance,
  requestId: string | undefined,
  payload: Extract<ChildToParentEnvelope, { type: "blob.delete" }>["payload"],
): Promise<void> {
  if (!requestId) {
    history("blob.delete.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      key: payload.key,
      error: "missingRequestId",
    });
    return;
  }
  const keyCheck = validateBlobKey(payload.key);
  if (!keyCheck.ok) {
    history("blob.delete.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      requestId,
      key: payload.key,
      error: "storageUnavailable",
      detail: { message: keyCheck.message },
    });
    if (inst.child) sendTyped(inst.child, "blob.delete.response", { ok: true }, requestId);
    return;
  }
  try {
    await objectStore.delete(blobObjectKey(inst.gameId, keyCheck.key));
    await refreshBlobUsage(inst);
    history("blob.delete", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      requestId,
      key: keyCheck.key,
      blobBytes: inst.blobBytes,
      blobKeys: inst.blobKeys,
    });
  } catch (err) {
    history("blob.delete.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      requestId,
      key: keyCheck.key,
      error: "storageUnavailable",
      detail: { message: err instanceof Error ? err.message : String(err) },
    });
  }
  maybeSendCapacityWarnings(inst);
  if (inst.child) sendTyped(inst.child, "blob.delete.response", { ok: true }, requestId);
}

async function handleBlobList(
  inst: GameInstance,
  requestId: string | undefined,
  payload: Extract<ChildToParentEnvelope, { type: "blob.list" }>["payload"],
): Promise<void> {
  if (!requestId) {
    history("blob.list.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      prefix: payload.prefix,
      error: "missingRequestId",
    });
    return;
  }
  const prefixCheck = validateBlobPrefix(payload.prefix ?? "");
  if (!prefixCheck.ok) {
    history("blob.list.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      requestId,
      prefix: payload.prefix,
      error: "storageUnavailable",
      detail: { message: prefixCheck.message },
    });
    if (inst.child) sendTyped(inst.child, "blob.list.response", { items: [] }, requestId);
    return;
  }
  try {
    const namespacePrefix = blobObjectPrefix(inst.gameId);
    const entries = await objectStore.list(`${namespacePrefix}${prefixCheck.prefix}`);
    const items = entries.map((entry) => ({
      key: entry.key.slice(namespacePrefix.length),
      size: entry.size,
    }));
    if (prefixCheck.prefix.length === 0) {
      inst.blobBytes = items.reduce((sum, item) => sum + item.size, 0);
      inst.blobKeys = items.length;
    }
    history("blob.list", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      requestId,
      prefix: payload.prefix,
      keyCount: items.length,
    });
    if (inst.child) sendTyped(inst.child, "blob.list.response", { items }, requestId);
  } catch (err) {
    history("blob.list.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      requestId,
      prefix: payload.prefix,
      error: "storageUnavailable",
      detail: { message: err instanceof Error ? err.message : String(err) },
    });
    if (inst.child) sendTyped(inst.child, "blob.list.response", { items: [] }, requestId);
  }
}

async function handleStateFlush(
  inst: GameInstance,
  requestId: string | undefined,
): Promise<void> {
  if (!requestId) {
    history("state.flush.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      reason: "missingRequestId",
    });
    return;
  }
  const flush = await flushStateCache(inst);
  const response = flush.response;
  history("state.flush", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    requestId,
    ok: response.ok,
    byteSize: flush.byteSize,
    flushed: flush.flushed,
    error: response.ok ? undefined : response.error,
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
    payload.triggeringSessionId == null
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
    traceId: triggeringSession?.traceId ?? null,
  };

  history("api.invoke.request", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    requestId,
    kind: payload.kind,
    triggeringSessionId: input.triggeringSessionId,
    traceId: input.traceId,
    connectedSessionCount: input.connectedSessions.length,
  });

  const result = await dispatchApiInvoke(input);
  const response = result.response;
  history("api.invoke.response", {
    actorId: inst.actorId,
    gameId: inst.gameId,
    requestId,
    kind: payload.kind,
    traceId: input.traceId,
    ok: response.ok,
    error: response.ok ? undefined : response.error,
    fingerprint: result.wireRecord?.fingerprint,
    mode: result.wireRecord?.mode,
    statusCode: result.wireRecord?.statusCode,
  });
  if (result.wireRecord) {
    history("api.invoke.wire", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      requestId,
      kind: payload.kind,
      gatewayRequestId: result.wireRecord.requestId,
      runId: inst.runId,
      traceId: input.traceId,
      fingerprint: result.wireRecord.fingerprint,
      mode: result.wireRecord.mode,
      statusCode: result.wireRecord.statusCode,
      error: result.wireRecord.error,
      rawOutbound: result.wireRecord.rawOutbound,
      rawInbound: result.wireRecord.rawInbound,
      recordedAt: result.wireRecord.recordedAt,
    });
  }
  if (inst.child) {
    sendTyped(inst.child, "api.invoke.response", { response }, requestId);
  }
}

async function dispatchApiInvoke(
  input: ApiGatewayDispatchInput,
): Promise<ApiGatewayInvokeResult> {
  try {
    const res = await fetch(PAX_API_GATEWAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const raw = await res.text();
    if (!res.ok) {
      return {
        response: {
          ok: false,
          error: "providerError",
          detail: { statusCode: res.status, body: raw },
        },
      };
    }
    return parseApiGatewayInvokeResult(raw);
  } catch (err) {
    return {
      response: {
        ok: false,
        error: "providerError",
        detail: { message: err instanceof Error ? err.message : String(err) },
      },
    };
  }
}

function parseApiGatewayInvokeResult(raw: string): ApiGatewayInvokeResult {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const responseRaw = parsed["response"];
  if (isRecord(responseRaw)) {
    const response = parseApiInvokeResponseRecord(responseRaw);
    const wireRecordRaw = parsed["wireRecord"];
    return {
      response,
      wireRecord: parseApiInvokeWireRecord(wireRecordRaw),
    };
  }
  return { response: parseApiInvokeResponseRecord(parsed) };
}

function parseApiInvokeResponseRecord(parsed: Readonly<Record<string, unknown>>): ApiInvokeResponse {
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
    detail: { message: "gateway returned malformed api.invoke response", raw: parsed },
  };
}

function parseApiInvokeWireRecord(raw: unknown): ApiInvokeWireRecord | undefined {
  if (!isRecord(raw)) return undefined;
  if (
    raw["event"] !== "api.invoke" ||
    typeof raw["requestId"] !== "string" ||
    typeof raw["fingerprint"] !== "string" ||
    (raw["mode"] !== "live" && raw["mode"] !== "replay") ||
    typeof raw["kind"] !== "string" ||
    typeof raw["gameId"] !== "string" ||
    typeof raw["runId"] !== "string" ||
    typeof raw["rawOutbound"] !== "string" ||
    typeof raw["rawInbound"] !== "string" ||
    typeof raw["statusCode"] !== "number" ||
    typeof raw["recordedAt"] !== "string"
  ) {
    return undefined;
  }
  const error = raw["error"];
  if (error !== undefined && !isApiInvokeError(error)) return undefined;
  return raw as unknown as ApiInvokeWireRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
  tier: "state",
): Promise<StorageReadResponsePayload> {
  void tier;
  return readGameState(inst);
}

async function writeGameStorage(
  inst: GameInstance,
  tier: "state",
  value: unknown,
): Promise<StorageWriteResponse> {
  void tier;
  return writeGameState(inst, value);
}

async function readGameState(inst: GameInstance): Promise<StorageReadResponsePayload> {
  if (!inst.stateLoaded) {
    try {
      const bytes = await objectStore.get(stateObjectKey(inst.gameId));
      if (bytes === null) {
        inst.stateLoaded = true;
        inst.stateFound = false;
        inst.stateValue = undefined;
        inst.stateBytes = 0;
      } else {
        inst.stateLoaded = true;
        inst.stateFound = true;
        inst.stateValue = cborDecode(bytes);
        inst.stateBytes = bytes.byteLength;
      }
      inst.stateDirty = false;
      inst.stateRevision = 0;
      inst.stateDurableRevision = 0;
    } catch (err) {
      history("state.read.error", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        objectKey: stateObjectKey(inst.gameId),
        objectStore: objectStore.kind,
        error: err instanceof Error ? err.message : String(err),
      });
      return { found: false, bytes: 0 };
    }
  }
  return inst.stateFound
    ? { found: true, value: inst.stateValue, bytes: inst.stateBytes }
    : { found: false, bytes: 0 };
}

function writeGameState(inst: GameInstance, value: unknown): StorageWriteResponse {
  const encoded = encodeGameState(value);
  if (!encoded.ok) return encoded.response;
  if (encoded.bytes.byteLength > STATE_BYTES_LIMIT) {
    return {
      ok: false,
      error: "sizeExceeded",
      detail: { bytes: encoded.bytes.byteLength, limit: STATE_BYTES_LIMIT },
    };
  }
  inst.stateLoaded = true;
  inst.stateFound = true;
  inst.stateValue = value;
  inst.stateBytes = encoded.bytes.byteLength;
  inst.stateDirty = true;
  inst.stateRevision += 1;
  scheduleStateFlush(inst);
  maybeSendCapacityWarnings(inst);
  return { ok: true };
}

function scheduleStateFlush(inst: GameInstance): void {
  if (STATE_FLUSH_WINDOW_MS === 0) {
    void flushStateCacheAndRecord(inst, "state.flush.scheduled");
    return;
  }
  if (inst.stateFlushTimer) return;
  inst.stateFlushTimer = setTimeout(() => {
    inst.stateFlushTimer = null;
    void flushStateCacheAndRecord(inst, "state.flush.scheduled");
  }, STATE_FLUSH_WINDOW_MS);
  inst.stateFlushTimer.unref();
}

async function flushStateCacheAndRecord(
  inst: GameInstance,
  event: "state.flush.scheduled",
): Promise<void> {
  const flush = await flushStateCache(inst);
  history(event, {
    actorId: inst.actorId,
    gameId: inst.gameId,
    runId: inst.runId,
    ok: flush.response.ok,
    byteSize: flush.byteSize,
    flushed: flush.flushed,
    objectStore: objectStore.kind,
    error: flush.response.ok ? undefined : flush.response.error,
  });
}

function flushStateCache(inst: GameInstance): Promise<StateFlushOutcome> {
  if (inst.stateFlushTimer) {
    clearTimeout(inst.stateFlushTimer);
    inst.stateFlushTimer = null;
  }
  if (inst.stateFlushPromise) return inst.stateFlushPromise;
  inst.stateFlushPromise = flushStateCacheInner(inst).finally(() => {
    inst.stateFlushPromise = null;
  });
  return inst.stateFlushPromise;
}

async function flushStateCacheInner(inst: GameInstance): Promise<StateFlushOutcome> {
  let flushed = false;
  try {
    while (inst.stateDirty) {
      const revision = inst.stateRevision;
      const encoded = encodeGameState(inst.stateValue);
      if (!encoded.ok) return { response: encoded.response, byteSize: inst.stateBytes, flushed };
      if (encoded.bytes.byteLength > STATE_BYTES_LIMIT) {
        return {
          response: {
            ok: false,
            error: "sizeExceeded",
            detail: { bytes: encoded.bytes.byteLength, limit: STATE_BYTES_LIMIT },
          },
          byteSize: encoded.bytes.byteLength,
          flushed,
        };
      }
      await objectStore.put(stateObjectKey(inst.gameId), encoded.bytes);
      flushed = true;
      inst.stateBytes = encoded.bytes.byteLength;
      if (inst.stateRevision === revision) {
        inst.stateDirty = false;
        inst.stateDurableRevision = revision;
      }
    }
    return { response: { ok: true }, byteSize: inst.stateBytes, flushed };
  } catch (err) {
    history("storage.unavailable", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      tier: "state",
      objectKey: stateObjectKey(inst.gameId),
      objectStore: objectStore.kind,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      response: {
        ok: false,
        error: "storageUnavailable",
        detail: { message: err instanceof Error ? err.message : String(err) },
      },
      byteSize: inst.stateBytes,
      flushed,
    };
  }
}

type EncodeStateResult =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly response: StorageWriteResponse };

function encodeGameState(value: unknown): EncodeStateResult {
  try {
    return { ok: true, bytes: cborEncode(value) };
  } catch (err) {
    return {
      ok: false,
      response: {
        ok: false,
        error: "storageUnavailable",
        detail: { message: err instanceof Error ? err.message : String(err) },
      },
    };
  }
}

function stateObjectKey(gameId: string): string {
  return `state/${gameId}.cbor`;
}

type BlobKeyCheck =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly message: string };

type BlobPrefixCheck =
  | { readonly ok: true; readonly prefix: string }
  | { readonly ok: false; readonly message: string };

type BlobBudgetCheck =
  | { readonly ok: true; readonly totalBytes: number; readonly totalKeys: number }
  | {
      readonly ok: false;
      readonly error: "sizeExceeded" | "keyCountExceeded";
      readonly detail: Readonly<Record<string, unknown>>;
    };

function validateBlobKey(key: string): BlobKeyCheck {
  if (typeof key !== "string" || key.length === 0) {
    return { ok: false, message: "blob key must be a non-empty string" };
  }
  const bytes = Buffer.byteLength(key, "utf8");
  if (bytes > 256) {
    return { ok: false, message: "blob key must be at most 256 UTF-8 bytes" };
  }
  const parts = key.split("/");
  if (
    key.startsWith("/") ||
    key.endsWith("/") ||
    parts.some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return { ok: false, message: "blob key must be namespace-relative" };
  }
  return { ok: true, key };
}

function validateBlobPrefix(prefix: string): BlobPrefixCheck {
  if (prefix.length === 0) return { ok: true, prefix };
  const bytes = Buffer.byteLength(prefix, "utf8");
  if (bytes > 256) {
    return { ok: false, message: "blob prefix must be at most 256 UTF-8 bytes" };
  }
  if (prefix.startsWith("/") || prefix.split("/").some((part) => part === "." || part === "..")) {
    return { ok: false, message: "blob prefix must be namespace-relative" };
  }
  return { ok: true, prefix };
}

function decodeBase64(raw: string): Uint8Array {
  return Buffer.from(raw, "base64");
}

async function prospectiveBlobBudget(
  inst: GameInstance,
  key: string,
  newSize: number,
): Promise<BlobBudgetCheck> {
  const entries = await objectStore.list(blobObjectPrefix(inst.gameId));
  const namespacePrefix = blobObjectPrefix(inst.gameId);
  const existing = entries.find((entry) => entry.key === `${namespacePrefix}${key}`);
  const currentBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const currentKeys = entries.length;
  const totalBytes = currentBytes - (existing?.size ?? 0) + newSize;
  const totalKeys = existing ? currentKeys : currentKeys + 1;
  if (totalBytes > BLOB_BYTES_LIMIT) {
    inst.blobBytes = currentBytes;
    inst.blobKeys = currentKeys;
    return {
      ok: false,
      error: "sizeExceeded",
      detail: {
        currentUsage: currentBytes,
        attemptedBytes: newSize,
        limit: BLOB_BYTES_LIMIT,
      },
    };
  }
  if (totalKeys > BLOB_KEYS_LIMIT) {
    inst.blobBytes = currentBytes;
    inst.blobKeys = currentKeys;
    return {
      ok: false,
      error: "keyCountExceeded",
      detail: {
        currentUsage: currentKeys,
        attemptedKeys: existing ? 0 : 1,
        limit: BLOB_KEYS_LIMIT,
      },
    };
  }
  return { ok: true, totalBytes, totalKeys };
}

async function refreshBlobUsage(inst: GameInstance): Promise<void> {
  const entries = await objectStore.list(blobObjectPrefix(inst.gameId));
  inst.blobBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  inst.blobKeys = entries.length;
}

function blobObjectPrefix(gameId: string): string {
  return `blob/${gameId}/`;
}

function blobObjectKey(gameId: string, key: string): string {
  return `${blobObjectPrefix(gameId)}${key}`;
}

function recordWsUsage(inst: GameInstance, bytes: number): void {
  inst.wsUsageSamples.push({ at: Date.now(), amount: bytes });
  pruneUsageSamples(inst.wsUsageSamples, 1_000);
  maybeSendCapacityWarnings(inst);
}

function recordApiInvokeUsage(inst: GameInstance): void {
  inst.apiInvokeSamples.push({ at: Date.now(), amount: 1 });
  pruneUsageSamples(inst.apiInvokeSamples, 60_000);
  maybeSendCapacityWarnings(inst);
}

function maybeSendCapacityWarnings(
  inst: GameInstance,
  snapshot = computeBudgetSnapshot(inst),
): void {
  if (!inst.child) return;
  const now = Date.now();
  for (const [budget, usage] of Object.entries(snapshot) as [
    ComputeBudgetName,
    ComputeBudgetUsage,
  ][]) {
    if (usage.limit <= 0) continue;
    const ratio = usage.currentUsage / usage.limit;
    if (ratio < CAPACITY_WARNING_RATIO) continue;
    const lastSentAt = inst.capacityWarningSentAt.get(budget) ?? 0;
    if (now - lastSentAt < CAPACITY_WARNING_COOLDOWN_MS) continue;
    inst.capacityWarningSentAt.set(budget, now);
    sendTyped(inst.child, "onCapacityWarning", {
      budget,
      currentUsage: usage.currentUsage,
      limit: usage.limit,
    });
    history("onCapacityWarning.sent", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      budget,
      currentUsage: usage.currentUsage,
      limit: usage.limit,
      ratio,
    });
  }
}

function computeBudgetSnapshot(inst: GameInstance): ComputeBudgetSnapshot {
  const wsSamples = pruneUsageSamples(inst.wsUsageSamples, 1_000);
  const apiSamples = pruneUsageSamples(inst.apiInvokeSamples, 60_000);
  const bandwidthBytes = wsSamples.reduce((sum, sample) => sum + sample.amount, 0);
  const wsMessages = wsSamples.length;
  const apiInvocations = apiSamples.reduce((sum, sample) => sum + sample.amount, 0);
  return {
    "cpu-ms-per-tick": {
      currentUsage: inst.lastHandlerDurationMs,
      limit: CPU_MS_PER_TICK_LIMIT,
    },
    "memory-bytes": {
      currentUsage: childRssBytes(inst.child),
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
    "blob-keys": {
      currentUsage: inst.blobKeys,
      limit: BLOB_KEYS_LIMIT,
    },
    "api-invocations-per-min": {
      currentUsage: apiInvocations,
      limit: API_INVOCATIONS_PER_MIN_LIMIT,
      windowMs: 60_000,
    },
  };
}

function childRssBytes(child: ChildProcess | null): number {
  const pid = child?.pid;
  if (!pid || pid <= 0) return 0;
  try {
    const fields = readFileSync(`/proc/${pid}/statm`, "utf8").trim().split(/\s+/);
    const rssPages = Number.parseInt(fields[1] ?? "", 10);
    return Number.isFinite(rssPages) && rssPages >= 0
      ? rssPages * PROCFS_PAGE_SIZE_BYTES
      : 0;
  } catch {
    return 0;
  }
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
  requestId: string | undefined,
  payload: Extract<ChildToParentEnvelope, { type: "ws.send" }>["payload"],
): void {
  const { target, body } = payload;
  const text = JSON.stringify(body);
  if (typeof text !== "string") {
    const response: WsSendResponse = {
      ok: false,
      error: "serializationFailed",
      detail: { message: "ws.send body must be JSON-serializable" },
    };
    history("ws.send.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      error: response.error,
      detail: response.detail,
    });
    respondWsSend(inst, requestId, response);
    return;
  }
  const sessions = Array.from(inst.sessions.values());
  const resolvedTargets = resolveWsSendTargets(target, sessions);
  if (!resolvedTargets.ok) {
    history("ws.send.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      error: resolvedTargets.response.error,
      detail: resolvedTargets.response.detail,
    });
    respondWsSend(inst, requestId, resolvedTargets.response);
    return;
  }
  const targets = resolvedTargets.targets;
  const frameBytes = Buffer.byteLength(text, "utf8");
  const prospectiveBytes = frameBytes * targets.length;
  const prospectiveMessages = targets.length;
  const budget = computeBudgetSnapshot(inst);
  const bandwidthUsage = budget["bandwidth-bytes-per-sec"].currentUsage;
  if (bandwidthUsage + prospectiveBytes > BANDWIDTH_BYTES_PER_SEC_LIMIT) {
    const response: WsSendResponse = {
      ok: false,
      error: "bandwidthExceeded",
      detail: {
        currentUsage: bandwidthUsage,
        attemptedBytes: prospectiveBytes,
        limit: BANDWIDTH_BYTES_PER_SEC_LIMIT,
        windowMs: 1_000,
      },
    };
    history("ws.send.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      error: response.error,
      bytes: prospectiveBytes,
      targetCount: targets.length,
      detail: response.detail,
    });
    respondWsSend(inst, requestId, response);
    maybeSendCapacityWarnings(inst, budget);
    return;
  }

  const messageUsage = budget["ws-messages-per-sec"].currentUsage;
  if (messageUsage + prospectiveMessages > WS_MESSAGES_PER_SEC_LIMIT) {
    const response: WsSendResponse = {
      ok: false,
      error: "rateExceeded",
      detail: {
        currentUsage: messageUsage,
        attemptedMessages: prospectiveMessages,
        limit: WS_MESSAGES_PER_SEC_LIMIT,
        windowMs: 1_000,
      },
    };
    history("ws.send.rejected", {
      actorId: inst.actorId,
      gameId: inst.gameId,
      runId: inst.runId,
      error: response.error,
      bytes: prospectiveBytes,
      targetCount: targets.length,
      detail: response.detail,
    });
    respondWsSend(inst, requestId, response);
    maybeSendCapacityWarnings(inst, budget);
    return;
  }

  let sent = 0;
  for (const sess of targets) {
    try {
      sess.ws.send(text);
      sent += 1;
      recordWsUsage(inst, frameBytes);
      history("ws.send", {
        actorId: inst.actorId,
        gameId: inst.gameId,
        runId: inst.runId,
        sessionId: sess.sessionId,
        playerId: sess.playerId,
        bytes: frameBytes,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ actorId: inst.actorId, err: msg }, "ws.send failed");
    }
  }
  respondWsSend(inst, requestId, {
    ok: true,
    sent,
    bytes: frameBytes * sent,
  });
}

type WsSendTargetResolution =
  | { readonly ok: true; readonly targets: readonly SessionRecord[] }
  | { readonly ok: false; readonly response: Extract<WsSendResponse, { readonly ok: false }> };

function resolveWsSendTargets(
  target: unknown,
  sessions: readonly SessionRecord[],
): WsSendTargetResolution {
  if (target === "all") return { ok: true, targets: sessions };
  if (typeof target === "string") {
    if (target.length === 0) return wsSendTargetInvalid("target must be a non-empty string");
    const targets = sessions.filter((session) => session.playerId === target);
    if (targets.length === 0) return wsSendTargetNotConnected([target]);
    return { ok: true, targets };
  }
  if (Array.isArray(target)) {
    if (target.length === 0) return wsSendTargetInvalid("target array must be non-empty");
    if (!target.every((entry) => typeof entry === "string" && entry.length > 0)) {
      return wsSendTargetInvalid("target array entries must be non-empty strings");
    }
    const requestedTargets = Array.from(new Set(target as readonly string[]));
    const requestedTargetSet = new Set(requestedTargets);
    const connectedTargets = new Set(sessions.map((session) => session.playerId));
    const missingTargets = requestedTargets.filter((playerId) => !connectedTargets.has(playerId));
    if (missingTargets.length > 0) return wsSendTargetNotConnected(missingTargets);
    return {
      ok: true,
      targets: sessions.filter((session) => requestedTargetSet.has(session.playerId)),
    };
  }
  return wsSendTargetInvalid("target must be 'all', a playerId, or a playerId array");
}

function wsSendTargetInvalid(message: string): WsSendTargetResolution {
  return {
    ok: false,
    response: {
      ok: false,
      error: "targetInvalid",
      detail: { message },
    },
  };
}

function wsSendTargetNotConnected(missingTargets: readonly string[]): WsSendTargetResolution {
  return {
    ok: false,
    response: {
      ok: false,
      error: "targetNotConnected",
      detail: { missingTargets },
    },
  };
}

function respondWsSend(
  inst: GameInstance,
  requestId: string | undefined,
  response: WsSendResponse,
): void {
  if (!requestId || !inst.child) return;
  sendTyped(inst.child, "ws.send.response", { response }, requestId);
}

// --- JWT verify --------------------------------------------------------

interface PlacementClaims {
  readonly gameId: string;
  readonly shardId: string;
  readonly userId: string;
  readonly bundleName: string;
  readonly runId: string;
  readonly traceId: string;
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
    !isTraceId(claims.traceId) ||
    typeof claims.exp !== "number"
  ) {
    throw new Error("placement token missing required claims");
  }
  return claims as PlacementClaims;
}

function isTraceId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
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
    const placementTokenStr = url.searchParams.get("placementToken") ?? url.searchParams.get("token");
    if (!placementTokenStr) {
      ws.close(4401, "missing placementToken");
      return;
    }
    let claims: PlacementClaims;
    try {
      claims = verifyPlacementToken(placementTokenStr);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ err: msg }, "placement token invalid");
      ws.close(4401, "invalid placementToken");
      return;
    }
    if (claims.shardId !== SHARD_ID) {
      ws.close(4403, "wrong shard");
      return;
    }

    const inst = games.get(actorId);
    if (!inst) {
      log.error({ actorId }, "websocket arrived before actor start");
      ws.close(1011, "actor not ready");
      return;
    }
    if (claims.gameId !== inst.gameId) {
      history("connection.refused", {
        actorId,
        gameId: inst.gameId,
        playerId: claims.userId,
        traceId: claims.traceId,
        reason: "wrongGame",
        tokenGameId: claims.gameId,
      });
      ws.close(4403, "wrong game");
      return;
    }
    const playerId = claims.userId;
    const hostEventWake = playerId === HOST_EVENT_WAKE_USER_ID;
    const allowed = hostEventWake ? true : await isPlayerAllowed(inst.gameId, playerId);
    if (!allowed) {
      history("connection.refused", {
        actorId,
        gameId: inst.gameId,
        playerId,
        traceId: claims.traceId,
        reason: "notAllowed",
      });
      ws.close(4403, "player not allowed");
      return;
    }
    if (!inst.child && !inst.bootstrapPromise && !(await refreshBundleForWake(inst))) {
      ws.close(1011, "bundle compat rejected");
      return;
    }
    await forkChild(inst);
    markGameActive(inst);
    cancelSleepGrace(inst, "sessionOpened");
    void writeActiveGameDirectory(inst);

    if (hostEventWake) {
      history("connection.hostEventWake", {
        actorId,
        gameId: inst.gameId,
        playerId,
        traceId: claims.traceId,
      });
      ws.close(1000, "host event wake complete");
      return;
    }

    const sessionId = idGenerator.generateSessionId();
    const connectedAt = Date.now();
    const sess: SessionRecord = {
      ws,
      sessionId,
      playerId,
      connectedAt,
      traceId: claims.traceId,
      jwtClaims: claims as unknown as Readonly<Record<string, unknown>>,
      seq: 0,
    };
    inst.sessions.set(sessionId, sess);

    history("session.opened", {
      actorId,
      gameId: inst.gameId,
      sessionId,
      playerId,
      traceId: claims.traceId,
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
        traceId: sess.traceId,
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
          traceId: sess.traceId,
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
        if (inst.sessions.size === 0) {
          scheduleIdleSleepGrace(inst);
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
    const bundle = await loadBundle(bundleName);
    history("bundle.loaded", {
      actorId,
      gameId,
      bundleName,
      bundleOrigin: bundle.origin,
      bundleCompatTag: bundle.manifest.compatTagProduced,
      runtimeContractRequired: bundle.manifest.runtimeContractRequired,
      contentSha256: bundle.contentSha256,
    });
    if (!bundleAcceptsBlobCompatTag(bundle.manifest, blobCompatTag)) {
      history("bundle.coldWake.rejected", {
        actorId,
        gameId,
        bundleName,
        bundleCompatTag: bundle.manifest.compatTagProduced,
        error: "compatTagOutOfRange",
        blobCompatTag,
        bundleCompatTagsAccepted: bundle.manifest.compatTagsAccepted,
      });
      log.warn(
        {
          actorId,
          gameId,
          bundleName,
          blobCompatTag,
          bundleCompatTagsAccepted: bundle.manifest.compatTagsAccepted,
        },
        "cold wake refused by bundle compat gate",
      );
      return;
    }
    const inst = ensureGame(actorId, gameId, bundle, blobCompatTag);
    wakeMetrics.recentWakes += 1;
    log.info({ actorId, gameId, bundleName }, "actor start; forking child");
    await forkChild(inst);
    await writeActiveGameDirectory(inst);
  },

  onActorStop: async (actorId: string, _generation: number): Promise<void> => {
    const inst = games.get(actorId);
    if (!inst) return;
    log.info({ actorId, gameId: inst.gameId }, "actor stop");
    history("actor.stop", { actorId, gameId: inst.gameId });
    sendOnSleep(inst, "shutdown");
    inst.active = false;
    recomputeActiveGameCount();
    try {
      await redis.del(`${ACTIVE_GAMES_KEY_PREFIX}${inst.gameId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ gameId: inst.gameId, err: msg }, "active_games delete failed");
    }
    games.delete(actorId);
    recomputeActiveGameCount();
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
      childRunner: CHILD_RUNNER_KIND,
      runtimeContractsSupported: RUNTIME_CONTRACTS_SUPPORTED,
      historyPath: HISTORY_PATH,
      metricsBind: `${PARENT_METRICS_BIND.host}:${PARENT_METRICS_BIND.port}`,
    },
    "parent-actor boot",
  );

  startMetricsServer(PARENT_METRICS_BIND);
  startHostEventDrainLoop();

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
