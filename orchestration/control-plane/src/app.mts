import { appendFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Redis } from "ioredis";

import {
  type ApiKindRegistration,
  DEFAULT_BLOB_BYTES_LIMIT,
  DEFAULT_STATE_BYTES_LIMIT,
  type BundleRecord,
  type GameRecord,
} from "@pax-backend/ipc-protocol";

import {
  connectedPlayersForGame,
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

export interface ControlPlaneConfig {
  readonly bindHost: string;
  readonly bindPort: number;
  readonly baseUrl: string;
  readonly redisUrl: string;
  readonly historyPath: string;
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
    historyPath: env["PAX_HISTORY_PATH"] ?? join(REPO_ROOT, "var", "history.jsonl"),
  };
}

export function createControlPlaneServer(config: ControlPlaneConfig): ControlPlaneServer {
  const redis = new Redis(config.redisUrl, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
  });
  const store = new ControlPlaneStore(redis);
  const server = createServer((req, res) => {
    void handleRequest(req, res, store, config);
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
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", config.baseUrl);
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, { status: "ok", runtime: "control-plane" });
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

    if (parts[0] === "admin" && parts[1] === "games" && parts.length === 2) {
      await handleGamesCollection(req, res, store);
      return;
    }

    if (parts[0] === "admin" && parts[1] === "shards" && parts.length === 2) {
      await handleShardsCollection(req, res, store);
      return;
    }

    if (parts[0] === "admin" && parts[1] === "shards" && parts.length >= 3) {
      await handleShardResource(req, res, store, parts);
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
      await handleGamesByCompatTag(res, store, parts[3] ?? "");
      return;
    }

    if (parts[0] === "admin" && parts[1] === "games" && parts.length >= 3) {
      await handleGameResource(req, res, store, config, parts, url);
      return;
    }

    writeJson(res, 404, { ok: false, error: "notFound" });
  } catch (err) {
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
  const body = asRecord(await readJson(req), "bundle upload body");
  const manifest = assertBundleManifest(body["manifest"] ?? body);
  const record: BundleRecord = {
    bundleName,
    manifest,
    source: readOptionalString(body, "source"),
    publishedAt: Date.now(),
  };
  const created = await store.putBundleWriteOnce(record);
  if (!created) throw new HttpError(409, "bundleAlreadyExists", { bundleName });
  writeJson(res, 201, { ok: true, bundle: record });
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
  if (Object.prototype.hasOwnProperty.call(body, "initialBlobUrl")) {
    throw new HttpError(400, "unsupportedField", {
      field: "initialBlobUrl",
      message: "inline initialBlob is supported; URL ingestion is not wired in this pass",
    });
  }
  const initialState = readOptionalStoredValue(body, "initialState", STATE_BYTES_LIMIT);
  const initialBlob = readOptionalStoredValue(body, "initialBlob", BLOB_BYTES_LIMIT);
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
      const allowedPlayers = await store.listAllowedPlayers(gameId);
      writeJson(res, 200, {
        ok: true,
        game,
        allowedPlayerCount: allowedPlayers.length,
      });
      return;
    }
    if (req.method === "DELETE") {
      const deleted = await store.deleteGame(gameId);
      writeJson(res, deleted ? 200 : 404, { ok: deleted });
      return;
    }
  }

  if (parts.length === 4 && parts[3] === "bundle" && req.method === "POST") {
    await handleBundleFlip(req, res, store, gameId);
    return;
  }

  if (parts.length === 4 && parts[3] === "bundle-compat" && req.method === "GET") {
    await handleBundleCompatDryRun(res, store, gameId, url.searchParams.get("bundleName"));
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

async function handleShardsCollection(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
): Promise<void> {
  if (req.method !== "GET") {
    throw new HttpError(405, "methodNotAllowed", { method: req.method });
  }
  writeJson(res, 200, { ok: true, shards: await store.listShards() });
}

async function handleShardResource(
  req: IncomingMessage,
  res: ServerResponse,
  store: ControlPlaneStore,
  parts: readonly string[],
): Promise<void> {
  const shardId = parts[2] ?? "";
  if (parts.length === 3 && req.method === "GET") {
    const shard = await store.getShard(shardId);
    if (!shard) throw new HttpError(404, "shardNotFound", { shardId });
    writeJson(res, 200, { ok: true, shard });
    return;
  }

  if (parts.length === 4 && parts[3] === "drain" && req.method === "POST") {
    const shard = await store.setShardDrain(shardId, true);
    if (!shard) throw new HttpError(404, "shardNotFound", { shardId });
    writeJson(res, 200, { ok: true, draining: true, shard });
    return;
  }

  if (parts.length === 4 && parts[3] === "drain" && req.method === "DELETE") {
    const shard = await store.setShardDrain(shardId, false);
    if (!shard) throw new HttpError(404, "shardNotFound", { shardId });
    writeJson(res, 200, { ok: true, draining: false, shard });
    return;
  }

  throw new HttpError(404, "notFound", { path: "/" + parts.join("/") });
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
  gameId: string,
): Promise<void> {
  const body = asRecord(await readJson(req), "bundle flip body");
  const newBundleName = readString(body, "newBundleName");
  const game = await requireGame(store, gameId);
  const bundle = await requireBundle(store, newBundleName);
  const compat = checkBundleCompat(game.blobCompatTag, bundle.manifest);
  if (!compat.ok) {
    writeJson(res, 409, compat);
    return;
  }
  const updated: GameRecord = { ...game, bundleName: newBundleName };
  await store.putGame(updated);
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
): Promise<void> {
  const games = (await store.listGames()).filter((game) =>
    tag === "untagged" ? game.blobCompatTag === undefined : game.blobCompatTag === tag,
  );
  writeJson(res, 200, { ok: true, tag, games });
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

function appendControlHistory(
  config: ControlPlaneConfig,
  event: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  mkdirSync(dirname(config.historyPath), { recursive: true });
  appendFileSync(
    config.historyPath,
    `${JSON.stringify({ ts: new Date().toISOString(), shardId: "control-plane", event, ...fields })}\n`,
  );
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

function readOptionalStoredValue(
  record: Readonly<Record<string, unknown>>,
  field: "initialState" | "initialBlob",
  limit: number,
): { readonly raw: string; readonly bytes: number } | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, field)) return undefined;
  let raw: string;
  try {
    raw = JSON.stringify({ value: record[field] });
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
