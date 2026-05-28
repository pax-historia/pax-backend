import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Redis } from "ioredis";
import WebSocket from "ws";

import { startPaxNodeTelemetry } from "@pax-backend/node-telemetry";
import {
  type ApiKindRegistration,
  DEFAULT_BLOB_BYTES_LIMIT,
  DEFAULT_STATE_BYTES_LIMIT,
  type BundleRecord,
  type GameRecord,
  type HostEventRecord,
  HOST_EVENT_QUEUE_TTL_SECONDS,
  type ShardRegistration,
} from "@pax-backend/ipc-protocol";

startPaxNodeTelemetry({ serviceName: "pax-control-plane", paxZone: "orchestration" });

import {
  apiWireRecordsForGame,
  connectedPlayersForGame,
  lastActivityAtForGame,
  queryHistory,
  sessionById,
  sessionsForGame,
} from "./history.mjs";
import { checkBundleCompat, assertBundleManifest } from "./manifest.mjs";
import { ControlPlaneStore } from "./store.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const STATE_BYTES_LIMIT = Number.parseInt(
  process.env["PAX_STATE_BYTES_LIMIT"] ?? String(DEFAULT_STATE_BYTES_LIMIT),
  10,
);
const BLOB_BYTES_LIMIT = Number.parseInt(
  process.env["PAX_BLOB_BYTES_LIMIT"] ?? String(DEFAULT_BLOB_BYTES_LIMIT),
  10,
);
const INITIAL_VALUE_FETCH_TIMEOUT_MS = parsePositiveInteger(
  process.env["PAX_INITIAL_VALUE_FETCH_TIMEOUT_MS"] ?? "10000",
  10_000,
);
const ROLLBACK_BACKUP_RETENTION_MS = parsePositiveInteger(
  process.env["PAX_ROLLBACK_BACKUP_RETENTION_MS"] ?? "604800000",
  604_800_000,
);
const TIGRIS_BUCKET =
  process.env["BUCKET_NAME"] ?? process.env["PAX_TIGRIS_BUCKET"] ?? "";
const TIGRIS_REGION = process.env["AWS_REGION"] ?? "auto";
const TIGRIS_ENDPOINT = process.env["AWS_ENDPOINT_URL_S3"];
const LOCAL_TIGRIS_DIR =
  process.env["PAX_LOCAL_TIGRIS_DIR"] ?? join(REPO_ROOT, "var", "tigris-local");
const CONTROL_PLANE_SHARD_ID = "control-plane";
const nextControlPaxSeqByPath = new Map<string, number>();

export interface ControlPlaneConfig {
  readonly bindHost: string;
  readonly bindPort: number;
  readonly baseUrl: string;
  readonly redisUrl: string;
  readonly routerUrl: string;
  readonly historyPath: string;
  readonly apiWireRecordsPath: string;
}

interface ControlPlaneMetrics {
  requestsTotal: number;
  errorsTotal: number;
}

interface BundleObjectStore {
  put(key: string, body: string, contentType: string): Promise<void>;
  get(key: string): Promise<string | undefined>;
}

class S3BundleObjectStore implements BundleObjectStore {
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

  async put(key: string, body: string, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!result.Body) return "";
      return responseBodyToString(result.Body);
    } catch (err) {
      if (isObjectNotFound(err)) return undefined;
      throw err;
    }
  }
}

class LocalBundleObjectStore implements BundleObjectStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, body: string): Promise<void> {
    const path = localObjectPath(this.root, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, "utf8");
  }

  async get(key: string): Promise<string | undefined> {
    try {
      return await readFile(localObjectPath(this.root, key), "utf8");
    } catch (err) {
      if (isErrnoException(err) && err.code === "ENOENT") return undefined;
      throw err;
    }
  }
}

const bundleObjectStore: BundleObjectStore =
  TIGRIS_BUCKET.length > 0
    ? new S3BundleObjectStore(TIGRIS_BUCKET, TIGRIS_REGION, TIGRIS_ENDPOINT)
    : new LocalBundleObjectStore(LOCAL_TIGRIS_DIR);

async function responseBodyToString(body: unknown): Promise<string> {
  if (body && typeof body === "object" && "transformToString" in body) {
    return (body as { transformToString: () => Promise<string> }).transformToString();
  }
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  if (typeof body === "string") return body;
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new Error("Tigris object body is not readable");
}

function isObjectNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { readonly name?: unknown; readonly $metadata?: unknown };
  const metadata = candidate.$metadata;
  const statusCode =
    metadata && typeof metadata === "object"
      ? (metadata as { readonly httpStatusCode?: unknown }).httpStatusCode
      : undefined;
  return candidate.name === "NoSuchKey" || statusCode === 404;
}

function localObjectPath(root: string, key: string): string {
  const resolvedRoot = resolve(root);
  const path = resolve(resolvedRoot, ...key.split("/").filter((part) => part.length > 0));
  if (path !== resolvedRoot && !path.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`object key escapes local object store root: ${key}`);
  }
  return path;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function sha256String(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export interface ControlPlaneServer {
  readonly server: Server;
  readonly store: ControlPlaneStore;
  readonly config: ControlPlaneConfig;
}

export function configFromEnv(env: NodeJS.ProcessEnv): ControlPlaneConfig {
  const bind = parseBind(env["PAX_CONTROL_BIND"] ?? "127.0.0.1:9070");
  return {
    bindHost: bind.host,
    bindPort: bind.port,
    baseUrl: env["PAX_CONTROL_BASE_URL"] ?? `http://${bind.host}:${bind.port}`,
    redisUrl: env["REDIS_URL"] ?? "redis://127.0.0.1:6379",
    routerUrl: env["PAX_ROUTER_URL"] ?? "http://127.0.0.1:9080",
    historyPath: env["PAX_HISTORY_PATH"] ?? join(REPO_ROOT, "var", "history.jsonl"),
    apiWireRecordsPath:
      env["PAX_API_WIRE_RECORDS_PATH"] ?? join(REPO_ROOT, "var", "api-invoke-records.jsonl"),
  };
}

export function createControlPlaneServer(config: ControlPlaneConfig): ControlPlaneServer {
  const redis = new Redis(config.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
  });
  const store = new ControlPlaneStore(redis);
  const metrics: ControlPlaneMetrics = {
    requestsTotal: 0,
    errorsTotal: 0,
  };
  const server = createServer((req, res) => {
    void handleRequest(req, res, store, config, metrics);
  });
  return { server, store, config };
}

export async function startControlPlaneServer(
  config = configFromEnv(process.env),
): Promise<ControlPlaneServer> {
  const instance = createControlPlaneServer(config);
  await new Promise<void>((resolveListen) => {
    instance.server.listen(config.bindPort, config.bindHost, resolveListen);
  });
  return instance;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
  config: ControlPlaneConfig,
  metrics: ControlPlaneMetrics,
): Promise<void> {
  metrics.requestsTotal += 1;
  try {
    const url = new URL(req.url ?? "/", config.baseUrl);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, { status: "ok", runtime: "control-plane" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      writeText(res, 200, metricsText(metrics));
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin/history") {
      handleHistory(res, config, url);
      return;
    }

    if (
      req.method === "GET" &&
      parts[0] === "admin" &&
      parts[1] === "sessions" &&
      parts.length === 3
    ) {
      handleSessionLookup(res, config, parts[2] ?? "");
      return;
    }

    if (parts[0] === "admin" && parts[1] === "bundles" && parts.length === 3) {
      await handleBundle(req, res, store, parts[2] ?? "");
      return;
    }

    if (parts[0] === "admin" && parts[1] === "api-kinds" && parts.length === 2) {
      await handleApiKindsCollection(req, res, store);
      return;
    }

    if (parts[0] === "admin" && parts[1] === "api-kinds" && parts.length === 3) {
      await handleApiKindResource(req, res, store, parts[2] ?? "");
      return;
    }

    if (parts[0] === "admin" && parts[1] === "players" && parts.length === 3) {
      await handlePlayerResource(req, res, store, config, parts[2] ?? "");
      return;
    }

    if (
      parts[0] === "admin" &&
      parts[1] === "players" &&
      parts[3] === "games" &&
      parts.length === 4
    ) {
      await handlePlayerGames(req, res, store, parts[2] ?? "");
      return;
    }

    if (parts[0] === "admin" && parts[1] === "games" && parts.length === 2) {
      await handleGamesCollection(req, res, store);
      return;
    }

    if (parts[0] === "admin" && parts[1] === "shards" && parts.length === 2) {
      await handleShardsCollection(req, res, store, config);
      return;
    }

    if (parts[0] === "admin" && parts[1] === "shards" && parts.length >= 3) {
      await handleShardResource(req, res, store, config, parts);
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin/games/compat-tags") {
      await handleCompatTags(res, store);
      return;
    }

    if (
      req.method === "GET" &&
      parts[0] === "admin" &&
      parts[1] === "games" &&
      parts[2] === "by-compat-tag" &&
      parts.length === 4
    ) {
      await handleGamesByCompatTag(res, store, parts[3] ?? "", url);
      return;
    }

    if (parts[0] === "admin" && parts[1] === "games" && parts.length >= 3) {
      await handleGameResource(req, res, store, config, parts, url);
      return;
    }

    writeJson(res, 404, { ok: false, error: "notFound" });
  } catch (err) {
    metrics.errorsTotal += 1;
    if (err instanceof HttpError) {
      writeJson(res, err.statusCode, { ok: false, error: err.code, detail: err.detail });
      return;
    }
    writeJson(res, 500, {
      ok: false,
      error: "internal",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function handleBundle(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
  bundleName: string,
): Promise<void> {
  if (req.method === "GET") {
    const bundle = await store.getBundle(bundleName);
    if (!bundle) throw new HttpError(404, "bundleNotFound", { bundleName });
    writeJson(res, 200, { ok: true, bundle });
    return;
  }
  if (req.method === "DELETE") {
    const result = await store.deleteBundleIfUnused(bundleName);
    if (result.status === "inUse") {
      throw new HttpError(409, "bundleInUse", {
        bundleName,
        gameIds: result.gameIds,
      });
    }
    writeJson(res, result.status === "deleted" ? 200 : 404, {
      ok: result.status === "deleted",
      status: result.status,
    });
    return;
  }
  if (req.method !== "POST") {
    throw new HttpError(405, "methodNotAllowed", { method: req.method });
  }
  assertBundleName(bundleName);
  const body = asRecord(await readJson(req), "bundle upload body");
  const manifest = assertBundleManifest(body["manifest"] ?? body);
  const source = readString(body, "source");
  const uploadedAt = new Date().toISOString();
  const uploadedBy = req.headers["x-pax-uploaded-by"]?.toString() ?? "vercel-backend";
  const tigrisPath = `bundles/${bundleName}/`;
  const sourceObjectKey = `${tigrisPath}source.js`;
  const manifestObjectKey = `${tigrisPath}manifest.json`;
  const metadataObjectKey = `${tigrisPath}metadata.json`;
  const contentSha256 = sha256String(source);
  const sizeBytes = Buffer.byteLength(source, "utf8");
  const existing = await store.getBundle(bundleName);
  if (existing) throw new HttpError(409, "bundleAlreadyExists", { bundleName });
  const metadata = {
    bundleName,
    uploadedAt,
    uploadedBy,
    tigrisPath,
    sourceObjectKey,
    manifestObjectKey,
    metadataObjectKey,
    contentSha256,
    sizeBytes,
  };
  await bundleObjectStore.put(sourceObjectKey, source, "application/javascript; charset=utf-8");
  await bundleObjectStore.put(
    manifestObjectKey,
    JSON.stringify(manifest, null, 2),
    "application/json",
  );
  await bundleObjectStore.put(
    metadataObjectKey,
    JSON.stringify(metadata, null, 2),
    "application/json",
  );
  const storedSource = await bundleObjectStore.get(sourceObjectKey);
  if (storedSource === undefined || sha256String(storedSource) !== contentSha256) {
    throw new HttpError(503, "bundleStorageVerificationFailed", {
      bundleName,
      sourceObjectKey,
      contentSha256,
    });
  }
  const record: BundleRecord = {
    bundleName,
    manifest,
    uploadedAt,
    uploadedBy,
    tigrisPath,
    sourceObjectKey,
    manifestObjectKey,
    metadataObjectKey,
    contentSha256,
    sizeBytes,
  };
  const created = await store.putBundleWriteOnce(record);
  if (!created) throw new HttpError(409, "bundleAlreadyExists", { bundleName });
  writeJson(res, 201, { ok: true, bundle: record, contentSha256, sizeBytes });
}

async function handleGamesCollection(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
): Promise<void> {
  if (req.method !== "POST") {
    throw new HttpError(405, "methodNotAllowed", { method: req.method });
  }
  const body = asRecord(await readJson(req), "game create body");
  const gameId = readString(body, "gameId");
  const bundleName = readString(body, "bundleName");
  const bundle = await store.getBundle(bundleName);
  if (!bundle) throw new HttpError(404, "bundleNotFound", { bundleName });
  const initialState = await readOptionalStoredValue(
    body,
    "initialState",
    "initialStateUrl",
    STATE_BYTES_LIMIT,
  );
  const initialBlob = await readOptionalStoredValue(
    body,
    "initialBlob",
    "initialBlobUrl",
    BLOB_BYTES_LIMIT,
  );
  const game: GameRecord = {
    gameId,
    bundleName,
    blobCompatTag: readOptionalString(body, "blobCompatTag"),
    createdAt: Date.now(),
  };
  const created = await store.putGameWriteOnce(game);
  if (!created) throw new HttpError(409, "gameAlreadyExists", { gameId });
  if (initialState) await store.putStorageRaw(gameId, "state", initialState.raw);
  if (initialBlob) await store.putStorageRaw(gameId, "blob", initialBlob.raw);
  for (const playerId of readOptionalStringArray(body, "allowedPlayers")) {
    await store.addAllowedPlayer(gameId, playerId);
  }
  writeJson(res, 201, {
    ok: true,
    game,
    storage: {
      stateBytes: initialState?.bytes ?? 0,
      blobBytes: initialBlob?.bytes ?? 0,
    },
  });
}

async function handleApiKindsCollection(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
): Promise<void> {
  if (req.method === "GET") {
    writeJson(res, 200, { ok: true, kinds: await store.listApiKinds() });
    return;
  }
  if (req.method !== "POST") {
    throw new HttpError(405, "methodNotAllowed", { method: req.method });
  }
  const body = asRecord(await readJson(req), "api-kind registration");
  const registration: ApiKindRegistration = {
    kindName: readString(body, "kindName"),
    url: readString(body, "url"),
    registeredAt: Date.now(),
  };
  assertApiKindRegistration(registration);
  await store.putApiKind(registration);
  writeJson(res, 201, { ok: true, registration });
}

async function handleApiKindResource(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
  kindName: string,
): Promise<void> {
  if (req.method === "GET") {
    const registration = await store.getApiKind(kindName);
    if (!registration) throw new HttpError(404, "apiKindNotFound", { kindName });
    writeJson(res, 200, { ok: true, registration });
    return;
  }
  if (req.method === "DELETE") {
    const deleted = await store.deleteApiKind(kindName);
    writeJson(res, deleted ? 200 : 404, { ok: deleted });
    return;
  }
  throw new HttpError(405, "methodNotAllowed", { method: req.method });
}

async function handlePlayerResource(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
  config: ControlPlaneConfig,
  playerId: string,
): Promise<void> {
  if (req.method !== "DELETE") {
    throw new HttpError(405, "methodNotAllowed", { method: req.method });
  }
  if (playerId.length === 0) {
    throw new HttpError(400, "badRequest", { field: "playerId" });
  }
  const removedFromGameIds = await store.removePlayerFromAllAllowedLists(playerId);
  appendControlHistory(config, "player.deleted", {
    playerId,
    removedFromGameIds,
    removedFromGameCount: removedFromGameIds.length,
  });
  writeJson(res, 200, {
    ok: true,
    playerId,
    removedFromGameIds,
  });
}

async function handlePlayerGames(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
  playerId: string,
): Promise<void> {
  if (req.method !== "GET") {
    throw new HttpError(405, "methodNotAllowed", { method: req.method });
  }
  if (playerId.length === 0) {
    throw new HttpError(400, "badRequest", { field: "playerId" });
  }
  const games = await store.listGamesForAllowedPlayer(playerId);
  writeJson(res, 200, {
    ok: true,
    playerId,
    gameIds: games.map((game) => game.gameId),
    games,
  });
}

async function handleGameResource(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
  config: ControlPlaneConfig,
  parts: readonly string[],
  url: URL,
): Promise<void> {
  const gameId = parts[2] ?? "";
  if (parts.length === 3) {
    if (req.method === "GET") {
      const game = await requireGame(store, gameId);
      const [allowedPlayers, activeGame] = await Promise.all([
        store.listAllowedPlayers(gameId),
        store.getActiveGame(gameId),
      ]);
      const connectedPlayerCount = connectedPlayersForGame(config.historyPath, gameId).length;
      writeJson(res, 200, {
        ok: true,
        game,
        status: activeGame ? "active" : "asleep",
        currentShardId: activeGame?.shardId ?? null,
        currentBundleName: game.bundleName,
        blobCompatTag: game.blobCompatTag ?? null,
        allowedPlayerCount: allowedPlayers.length,
        connectedPlayerCount,
        createdAt: game.createdAt,
        lastActivityAt: lastActivityAtForGame(config.historyPath, gameId) ?? game.createdAt,
      });
      return;
    }
    if (req.method === "DELETE") {
      const deleted = await store.deleteGame(gameId);
      if (deleted) {
        appendControlHistory(config, "game.deleted", { gameId });
      }
      writeJson(res, deleted ? 200 : 404, { ok: deleted });
      return;
    }
  }

  if (parts.length === 4 && parts[3] === "bundle" && req.method === "POST") {
    await handleBundleFlip(req, res, store, config, gameId);
    return;
  }

  if (parts.length === 4 && parts[3] === "bundle-compat" && req.method === "GET") {
    await handleBundleCompatDryRun(res, store, gameId, url.searchParams.get("bundleName"));
    return;
  }

  if (parts.length === 4 && parts[3] === "snapshot" && req.method === "GET") {
    await handleGameSnapshot(res, store, config, gameId, url);
    return;
  }

  if (parts.length === 4 && parts[3] === "host-event" && req.method === "POST") {
    await handleHostEvent(req, res, store, config, gameId);
    return;
  }

  if (parts.length === 4 && parts[3] === "allowed-players" && req.method === "GET") {
    writeJson(res, 200, {
      ok: true,
      gameId,
      allowedPlayers: await store.listAllowedPlayers(gameId),
    });
    return;
  }

  if (parts.length === 4 && parts[3] === "connected-players" && req.method === "GET") {
    await requireGame(store, gameId);
    writeJson(res, 200, {
      ok: true,
      gameId,
      connectedPlayers: connectedPlayersForGame(config.historyPath, gameId).map((session) => ({
        sessionId: session.sessionId,
        playerId: session.playerId,
        connectedAt: session.connectedAt,
      })),
    });
    return;
  }

  if (parts.length === 4 && parts[3] === "sessions" && req.method === "GET") {
    await requireGame(store, gameId);
    writeJson(res, 200, {
      ok: true,
      gameId,
      sessions: sessionsForGame(config.historyPath, gameId, {
        from: url.searchParams.get("from") ?? undefined,
        to: url.searchParams.get("to") ?? undefined,
        playerId: url.searchParams.get("playerId") ?? undefined,
      }),
    });
    return;
  }

  if (parts.length === 5 && parts[3] === "allowed-players") {
    await requireGame(store, gameId);
    const playerId = parts[4] ?? "";
    if (req.method === "POST") {
      await store.addAllowedPlayer(gameId, playerId);
      writeJson(res, 200, { ok: true, gameId, playerId });
      return;
    }
    if (req.method === "DELETE") {
      const removed = await store.removeAllowedPlayer(gameId, playerId);
      writeJson(res, 200, { ok: true, removed, gameId, playerId });
      return;
    }
  }

  throw new HttpError(404, "notFound", { path: "/" + parts.join("/") });
}

async function handleHostEvent(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
  config: ControlPlaneConfig,
  gameId: string,
): Promise<void> {
  await requireGame(store, gameId);
  const body = asRecord(await readJson(req), "host-event body");
  const eventType = readString(body, "eventType");
  const payload = Object.prototype.hasOwnProperty.call(body, "payload")
    ? body["payload"]
    : null;
  const wakeOnDelivery = body["wakeOnDelivery"] === true;
  const activeGame = await store.getActiveGame(gameId);
  const now = Date.now();
  const record: HostEventRecord = {
    eventId: randomUUID(),
    gameId,
    eventType,
    payload,
    wakeOnDelivery,
    receivedAt: now,
    deliveryAttempts: 0,
    expiresAt: now + HOST_EVENT_QUEUE_TTL_SECONDS * 1000,
  };
  appendControlHistory(config, "onHostEvent.received", {
    gameId,
    eventId: record.eventId,
    eventType,
    payload,
    wakeOnDelivery,
    receivedAt: record.receivedAt,
  });

  if (!wakeOnDelivery && !activeGame) {
    appendControlHistory(config, "onHostEvent.dropped", {
      gameId,
      eventId: record.eventId,
      eventType,
      wakeOnDelivery,
      reason: "gameAsleep",
    });
    writeJson(res, 202, {
      ok: true,
      eventId: record.eventId,
      status: "dropped",
      wakeTriggered: false,
    });
    return;
  }

  await store.enqueueHostEvent(record, HOST_EVENT_QUEUE_TTL_SECONDS);
  let wakeTriggered = false;
  if (wakeOnDelivery && !activeGame) {
    await triggerHostEventWake(config, gameId);
    wakeTriggered = true;
  }
  writeJson(res, 202, {
    ok: true,
    eventId: record.eventId,
    status: "queued",
    wakeTriggered,
  });
}

async function triggerHostEventWake(
  config: ControlPlaneConfig,
  gameId: string,
): Promise<void> {
  const placementUrl = new URL(
    `/games/${encodeURIComponent(gameId)}/placement`,
    config.routerUrl,
  );
  placementUrl.searchParams.set("userId", "__pax_host_event__");
  const placementResponse = await fetch(placementUrl);
  if (!placementResponse.ok) {
    throw new HttpError(503, "hostEventWakePlacementFailed", {
      gameId,
      status: placementResponse.status,
      body: await placementResponse.text(),
    });
  }
  const placement = (await placementResponse.json()) as { readonly webSocketUrl?: unknown };
  if (typeof placement.webSocketUrl !== "string") {
    throw new HttpError(503, "hostEventWakePlacementFailed", {
      gameId,
      detail: "placement response missing webSocketUrl",
    });
  }
  await openWakeWebSocket(placement.webSocketUrl, gameId);
  appendControlHistory(config, "onHostEvent.wakeRequested", {
    gameId,
    placementUrl: placementUrl.toString(),
  });
}

function openWakeWebSocket(webSocketUrl: string, gameId: string): Promise<void> {
  return new Promise<void>((resolveWake, rejectWake) => {
    const ws = new WebSocket(webSocketUrl, [...rivetProtocols(gameId)]);
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // Ignore close races; timeout already decides the result.
      }
      rejectWake(new Error("host-event wake websocket timed out"));
    }, 5_000);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close(1000, "host-event wake complete");
      } catch {
        // The shard may already have closed the synthetic connection.
      }
      resolveWake();
    };
    ws.once("open", finish);
    ws.once("close", finish);
    ws.once("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectWake(err);
    });
  });
}

function rivetProtocols(gameId: string): readonly string[] {
  return [
    "rivet",
    "rivet_encoding.json",
    `rivet_conn_params.${encodeURIComponent(JSON.stringify({ name: gameId }))}`,
  ];
}

async function handleShardsCollection(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
  config: ControlPlaneConfig,
): Promise<void> {
  if (req.method !== "GET") {
    throw new HttpError(405, "methodNotAllowed", { method: req.method });
  }
  const shards = await Promise.all(
    (await store.listShards()).map(async (shard) => {
      await maybeEmitDrainCompleted(config, store, shard);
      return shardView(shard);
    }),
  );
  writeJson(res, 200, { ok: true, shards });
}

async function handleShardResource(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
  config: ControlPlaneConfig,
  parts: readonly string[],
): Promise<void> {
  const shardId = parts[2] ?? "";
  if (parts.length === 3 && req.method === "GET") {
    const shard = await store.getShard(shardId);
    if (!shard) throw new HttpError(404, "shardNotFound", { shardId });
    await maybeEmitDrainCompleted(config, store, shard);
    writeJson(res, 200, { ok: true, shard: shardView(shard) });
    return;
  }

  if (parts.length === 4 && parts[3] === "drain" && req.method === "POST") {
    const shard = await store.setShardDrain(shardId, true);
    if (!shard) throw new HttpError(404, "shardNotFound", { shardId });
    appendControlHistory(config, "shard.drain.started", {
      shardId,
      activeGames: shard.activeGames,
    });
    await maybeEmitDrainCompleted(config, store, shard);
    writeJson(res, 202, { ok: true, draining: true, shard: shardView(shard) });
    return;
  }

  if (parts.length === 4 && parts[3] === "drain" && req.method === "DELETE") {
    const shard = await store.setShardDrain(shardId, false);
    if (!shard) throw new HttpError(404, "shardNotFound", { shardId });
    writeJson(res, 200, { ok: true, draining: false, shard: shardView(shard) });
    return;
  }

  throw new HttpError(404, "notFound", { path: "/" + parts.join("/") });
}

async function maybeEmitDrainCompleted(
  config: ControlPlaneConfig,
  store: ControlPlaneStore,
  shard: ShardRegistrationLike,
): Promise<void> {
  const status = shardStatus(shard);
  if (status !== "drained") return;
  if (!(await store.markShardDrainCompletedOnce(shard.shardId))) return;
  appendControlHistory(config, "shard.drain.completed", {
    shardId: shard.shardId,
    activeGames: shard.activeGames,
  });
}

type ShardStatus = ShardRegistration["status"];
type ShardRegistrationLike = Omit<ShardRegistration, "status"> & {
  readonly status?: ShardStatus;
};

function shardStatus(shard: ShardRegistrationLike): ShardStatus {
  if (
    shard.status === "healthy" ||
    shard.status === "draining" ||
    shard.status === "drained" ||
    shard.status === "unhealthy"
  ) {
    return shard.status;
  }
  if (!shard.healthy) return "unhealthy";
  if (!shard.acceptingWakes) return shard.activeGames === 0 ? "drained" : "draining";
  return "healthy";
}

function shardView(shard: ShardRegistrationLike): Record<string, unknown> {
  return {
    ...shard,
    status: shardStatus(shard),
    currentGameCount: shard.activeGames,
  };
}

function handleHistory(
  res: ServerResponse,
  config: ControlPlaneConfig,
  url: URL,
): void {
  const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 500);
  const cursor = optionalInt(url.searchParams.get("cursor"));
  writeJson(res, 200, {
    ok: true,
    ...queryHistory(config.historyPath, {
      event: url.searchParams.get("event") ?? undefined,
      gameId: url.searchParams.get("gameId") ?? undefined,
      playerId: url.searchParams.get("playerId") ?? undefined,
      sessionId: url.searchParams.get("sessionId") ?? undefined,
      shardId: url.searchParams.get("shardId") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
      cursor,
      limit,
    }),
  });
}

function handleSessionLookup(
  res: ServerResponse,
  config: ControlPlaneConfig,
  sessionId: string,
): void {
  const session = sessionById(config.historyPath, sessionId);
  if (!session) throw new HttpError(404, "sessionNotFound", { sessionId });
  writeJson(res, 200, { ok: true, session });
}

async function handleBundleFlip(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
  config: ControlPlaneConfig,
  gameId: string,
): Promise<void> {
  const body = asRecord(await readJson(req), "bundle flip body");
  const newBundleName = readString(body, "newBundleName");
  const game = await requireGame(store, gameId);
  const bundle = await requireBundle(store, newBundleName);
  const compat = checkBundleCompat(game.blobCompatTag, bundle.manifest);
  if (!compat.ok) {
    appendControlHistory(config, "bundle.flip.rejected", {
      gameId,
      oldBundleName: game.bundleName,
      newBundleName,
      ...compat,
    });
    writeJson(res, 409, compat);
    return;
  }
  const now = Date.now();
  const updated: GameRecord = {
    ...game,
    bundleName: newBundleName,
    bundleRollback:
      game.bundleName === newBundleName
        ? game.bundleRollback
        : {
            previousBundleName: game.bundleName,
            failedBundleName: newBundleName,
            createdAt: now,
            expiresAt: now + ROLLBACK_BACKUP_RETENTION_MS,
            consecutiveWakeFailures: 0,
          },
  };
  await store.putGame(updated);
  appendControlHistory(config, "bundle.flip.succeeded", {
    gameId,
    oldBundleName: game.bundleName,
    newBundleName,
    blobCompatTag: game.blobCompatTag,
    rollbackBackupExpiresAt: updated.bundleRollback?.expiresAt,
  });
  writeJson(res, 200, { ok: true, game: updated });
}

async function handleBundleCompatDryRun(
  res: ServerResponse,
  store: ControlPlaneStore,
  gameId: string,
  bundleName: string | null,
): Promise<void> {
  if (!bundleName) throw new HttpError(400, "badRequest", { field: "bundleName" });
  const game = await requireGame(store, gameId);
  const bundle = await requireBundle(store, bundleName);
  const compat = checkBundleCompat(game.blobCompatTag, bundle.manifest);
  writeJson(res, compat.ok ? 200 : 409, compat);
}

async function handleGameSnapshot(
  res: ServerResponse,
  store: ControlPlaneStore,
  config: ControlPlaneConfig,
  gameId: string,
  url: URL,
): Promise<void> {
  const game = await requireGame(store, gameId);
  const includeBlob = url.searchParams.get("includeBlob") !== "false";
  const apiLimit = clampInt(url.searchParams.get("apiLimit"), 0, 1000, 100);
  const [allowedPlayers, stateRaw, blobRaw] = await Promise.all([
    store.listAllowedPlayers(gameId),
    store.getStorageRaw(gameId, "state"),
    includeBlob ? store.getStorageRaw(gameId, "blob") : Promise.resolve(undefined),
  ]);
  const connectedPlayers = connectedPlayersForGame(config.historyPath, gameId).map((session) => ({
    sessionId: session.sessionId,
    playerId: session.playerId,
    connectedAt: session.connectedAt,
  }));
  const recentApiInvokes =
    apiLimit === 0
      ? []
      : apiWireRecordsForGame(config.apiWireRecordsPath, config.historyPath, gameId, apiLimit);

  writeJson(res, 200, {
    ok: true,
    game,
    allowedPlayers,
    connectedPlayers,
    storage: {
      state: decodeStoredRaw(stateRaw),
      blob: includeBlob ? decodeStoredRaw(blobRaw) : { omitted: true },
    },
    recentApiInvokes,
  });
}

async function handleCompatTags(
  res: ServerResponse,
  store: ControlPlaneStore,
): Promise<void> {
  const histogram: Record<string, number> = { untagged: 0 };
  for (const game of await store.listGames()) {
    const key = game.blobCompatTag ?? "untagged";
    histogram[key] = (histogram[key] ?? 0) + 1;
  }
  writeJson(res, 200, { ok: true, compatTags: histogram });
}

async function handleGamesByCompatTag(
  res: ServerResponse,
  store: ControlPlaneStore,
  tag: string,
  url: URL,
): Promise<void> {
  const limit = clampInt(url.searchParams.get("limit"), 1, 1000, 500);
  const cursor = optionalInt(url.searchParams.get("cursor")) ?? 0;
  const matchingGames = (await store.listGames())
    .filter((game) =>
      tag === "untagged" ? game.blobCompatTag === undefined : game.blobCompatTag === tag,
    )
    .sort((a, b) => a.gameId.localeCompare(b.gameId));
  const games = matchingGames.slice(cursor, cursor + limit);
  const nextCursor = cursor + games.length < matchingGames.length ? cursor + games.length : null;
  writeJson(res, 200, {
    ok: true,
    tag,
    cursor,
    limit,
    nextCursor,
    games,
  });
}

async function requireGame(
  store: ControlPlaneStore,
  gameId: string,
): Promise<GameRecord> {
  const game = await store.getGame(gameId);
  if (!game) throw new HttpError(404, "gameNotFound", { gameId });
  return game;
}

async function requireBundle(
  store: ControlPlaneStore,
  bundleName: string,
): Promise<BundleRecord> {
  const bundle = await store.getBundle(bundleName);
  if (!bundle) throw new HttpError(404, "bundleNotFound", { bundleName });
  return bundle;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "badJson", { message: "request body is not valid JSON" });
  }
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

function writeText(res: ServerResponse, statusCode: number, body: string): void {
  res.writeHead(statusCode, {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function metricsText(metrics: ControlPlaneMetrics): string {
  return [
    "# HELP pax_control_plane_requests_total Total HTTP requests handled by the control plane.",
    "# TYPE pax_control_plane_requests_total counter",
    `pax_control_plane_requests_total ${metrics.requestsTotal}`,
    "# HELP pax_control_plane_errors_total Total requests that returned through the error handler.",
    "# TYPE pax_control_plane_errors_total counter",
    `pax_control_plane_errors_total ${metrics.errorsTotal}`,
    "",
  ].join("\n");
}

function appendControlHistory(
  config: ControlPlaneConfig,
  event: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  mkdirSync(dirname(config.historyPath), { recursive: true });
  const paxSeq = nextControlPaxSeq(config.historyPath);
  appendFileSync(
    config.historyPath,
    `${JSON.stringify({
      ...fields,
      ts: new Date().toISOString(),
      shardId: CONTROL_PLANE_SHARD_ID,
      pax_seq: paxSeq,
      event,
    })}\n`,
  );
}

function nextControlPaxSeq(historyPath: string): number {
  const existing = nextControlPaxSeqByPath.get(historyPath);
  if (existing !== undefined) {
    nextControlPaxSeqByPath.set(historyPath, existing + 1);
    return existing;
  }
  const next = loadLastPaxSeqForShard(historyPath, CONTROL_PLANE_SHARD_ID) + 1;
  nextControlPaxSeqByPath.set(historyPath, next + 1);
  return next;
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

function asRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpError(400, "badRequest", { message: `${label} must be an object` });
  }
  return raw as Record<string, unknown>;
}

function readString(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "badRequest", { field, expected: "non-empty string" });
  }
  return value;
}

function assertBundleName(bundleName: string): void {
  if (!/^[A-Za-z0-9._-]{1,256}$/.test(bundleName)) {
    throw new HttpError(400, "badRequest", {
      field: "bundleName",
      expected: "1-256 characters: letters, numbers, dots, underscores, or hyphens",
    });
  }
}

function readOptionalString(
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "badRequest", { field, expected: "non-empty string" });
  }
  return value;
}

function readOptionalStringArray(
  record: Readonly<Record<string, unknown>>,
  field: string,
): readonly string[] {
  const value = record[field];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new HttpError(400, "badRequest", { field, expected: "string array" });
  }
  return value;
}

async function readOptionalStoredValue(
  record: Readonly<Record<string, unknown>>,
  field: "initialState" | "initialBlob",
  urlField: "initialStateUrl" | "initialBlobUrl",
  limit: number,
): Promise<{ readonly raw: string; readonly bytes: number } | undefined> {
  const hasInline = Object.prototype.hasOwnProperty.call(record, field);
  const hasUrl = Object.prototype.hasOwnProperty.call(record, urlField);
  if (hasInline && hasUrl) {
    throw new HttpError(400, "badRequest", {
      fields: [field, urlField],
      expected: "provide either inline value or URL, not both",
    });
  }
  if (hasUrl) {
    return fetchStoredValueFromUrl(readString(record, urlField), field, limit);
  }
  if (!hasInline) return undefined;
  return encodeStoredValue(record[field], field, limit);
}

async function fetchStoredValueFromUrl(
  rawUrl: string,
  field: "initialState" | "initialBlob",
  limit: number,
): Promise<{ readonly raw: string; readonly bytes: number }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "badRequest", { field: `${field}Url`, expected: "absolute URL" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "badRequest", {
      field: `${field}Url`,
      expected: "http or https URL",
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INITIAL_VALUE_FETCH_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new HttpError(502, "initialValueFetchFailed", {
        field,
        url: url.toString(),
        status: response.status,
      });
    }
    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > limit) {
      throw new HttpError(413, "sizeExceeded", { field, bytes: contentLength, limit });
    }

    const text = await response.text();
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (err) {
      throw new HttpError(502, "initialValueFetchFailed", {
        field,
        url: url.toString(),
        expected: "JSON response body",
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return encodeStoredValue(value, field, limit);
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, "initialValueFetchFailed", {
      field,
      url: url.toString(),
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function encodeStoredValue(
  value: unknown,
  field: "initialState" | "initialBlob",
  limit: number,
): { readonly raw: string; readonly bytes: number } {
  let raw: string;
  try {
    raw = JSON.stringify({ value });
  } catch (err) {
    throw new HttpError(400, "badRequest", {
      field,
      expected: "JSON-serializable value",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > limit) {
    throw new HttpError(413, "sizeExceeded", { field, bytes, limit });
  }
  return { raw, bytes };
}

function decodeStoredRaw(
  raw: string | undefined,
):
  | { readonly found: false; readonly bytes: 0 }
  | { readonly found: true; readonly bytes: number; readonly value?: unknown; readonly parseError?: string } {
  if (raw === undefined) return { found: false, bytes: 0 };
  const bytes = Buffer.byteLength(raw, "utf8");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Object.prototype.hasOwnProperty.call(parsed, "value")
    ) {
      return { found: true, bytes, value: (parsed as { value?: unknown }).value };
    }
    return { found: true, bytes, value: parsed };
  } catch (err) {
    return {
      found: true,
      bytes,
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

function parsePositiveInteger(raw: string, fallback: number): number {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function assertApiKindRegistration(registration: ApiKindRegistration): void {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\.v[0-9]+$/.test(registration.kindName)) {
    throw new HttpError(400, "badRequest", {
      field: "kindName",
      expected: "versioned API kind name such as mock-ai.v1",
    });
  }
  try {
    const url = new URL(registration.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("URL must be http or https");
    }
  } catch (err) {
    throw new HttpError(400, "badRequest", {
      field: "url",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function optionalInt(value: string | null): number | undefined {
  if (value === null || value.length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function clampInt(
  value: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === null || value.length === 0) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function parseBind(raw: string): { host: string; port: number } {
  const lastColon = raw.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === raw.length - 1) {
    throw new Error(`invalid PAX_CONTROL_BIND: ${raw}`);
  }
  const host = raw.slice(0, lastColon);
  const port = Number.parseInt(raw.slice(lastColon + 1), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid PAX_CONTROL_BIND port: ${raw}`);
  }
  return { host, port };
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly detail: unknown,
  ) {
    super(code);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const config = configFromEnv(process.env);
  await startControlPlaneServer(config);
  process.stdout.write(
    `control-plane listening on http://${config.bindHost}:${config.bindPort}\n`,
  );
}
