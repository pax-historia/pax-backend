import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Redis } from "ioredis";

import {
  ACTIVE_GAMES_KEY_PREFIX,
  ACTIVE_GAME_TTL_SECONDS,
  ALLOWED_PLAYERS_KEY_PREFIX,
  BUNDLE_KEY_PREFIX,
  GAME_KEY_PREFIX,
  SHARD_REGISTRY_KEY_PREFIX,
  SHARD_REGISTRY_TTL_SECONDS,
  type ActiveGamePlacement,
  type ApiGatewayInvokeResult,
  type BundleRecord,
  type GameRecord,
  type ShardRegistration,
} from "@pax-backend/ipc-protocol";

import type {
  BrokerActiveGameClaim,
  BrokerCapacityRow,
  BrokerGatewayInvokeInput,
  BrokerWakeInput,
} from "./index.mjs";

export class RedisBrokerDirectory {
  constructor(private readonly redis: Redis) {}

  async publishCapacity(row: BrokerCapacityRow): Promise<void> {
    const registration: ShardRegistration = {
      shardId: row.shardId,
      url: row.url,
      status: row.status,
      healthy: row.healthy,
      acceptingWakes: row.acceptingWakes,
      runtimeContractsSupported: row.runtimeContractsSupported,
      activeGames: row.activeGames,
      currentGameCount: row.currentGameCount,
      maxGames: row.maxGames,
      lastSeenAt: row.lastSeenAt,
      broker: { wsPath: "/gateway" },
    };
    await this.redis.set(
      `${SHARD_REGISTRY_KEY_PREFIX}${row.shardId}`,
      JSON.stringify(registration),
      "EX",
      SHARD_REGISTRY_TTL_SECONDS,
    );
  }

  async removeShard(shardId: string): Promise<void> {
    await this.redis.del(`${SHARD_REGISTRY_KEY_PREFIX}${shardId}`);
  }

  async claimActiveGame(input: BrokerActiveGameClaim): Promise<void> {
    const key = `${ACTIVE_GAMES_KEY_PREFIX}${input.gameId}`;
    const placement: ActiveGamePlacement = {
      gameId: input.gameId,
      shardId: input.shardId,
      placedAt: input.placedAt,
      refreshedAt: input.refreshedAt,
      generation: input.generation,
      brokerId: input.shardId,
    };
    const created = await this.redis.set(
      key,
      JSON.stringify(placement),
      "EX",
      ACTIVE_GAME_TTL_SECONDS,
      "NX",
    );
    if (created === "OK") return;
    const existing = await getJson<ActiveGamePlacement>(this.redis, key);
    if (existing?.shardId === input.shardId && existing.generation === input.generation) {
      await this.redis.set(key, JSON.stringify(placement), "EX", ACTIVE_GAME_TTL_SECONDS, "XX");
      return;
    }
    throw new Error(`game ${input.gameId} is already claimed by ${existing?.shardId ?? "unknown shard"}`);
  }

  async releaseActiveGame(gameId: string, generation?: number): Promise<void> {
    const key = `${ACTIVE_GAMES_KEY_PREFIX}${gameId}`;
    const existing = await getJson<ActiveGamePlacement>(this.redis, key);
    if (!existing) return;
    if (generation !== undefined && existing.generation !== generation) return;
    await this.redis.del(key);
  }
}

export class RedisAllowedPlayers {
  constructor(private readonly redis: Redis) {}

  async has(gameId: string, playerId: string): Promise<boolean> {
    return (await this.redis.sismember(`${ALLOWED_PLAYERS_KEY_PREFIX}${gameId}`, playerId)) === 1;
  }

  async list(gameId: string): Promise<readonly string[]> {
    return (await this.redis.smembers(`${ALLOWED_PLAYERS_KEY_PREFIX}${gameId}`)).sort();
  }
}

export class HttpApiGatewayClient {
  constructor(private readonly invokeUrl: string) {}

  async invoke(input: BrokerGatewayInvokeInput): Promise<ApiGatewayInvokeResult> {
    const response = await fetch(this.invokeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const raw = await response.text();
    if (!response.ok) {
      return {
        response: {
          ok: false,
          error: "providerError",
          detail: { statusCode: response.status, body: raw },
        },
      };
    }
    return JSON.parse(raw) as ApiGatewayInvokeResult;
  }
}

export class JsonlHistoryWriter {
  private paxSeq = 0;

  constructor(private readonly path: string) {}

  async write(event: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    this.paxSeq += 1;
    await appendFile(this.path, `${JSON.stringify({ pax_seq: this.paxSeq, ...event })}\n`, "utf8");
  }
}

export interface BundleSourceStore {
  get(key: string): Promise<string | undefined>;
}

export interface S3BundleSourceStoreConfig {
  readonly bucket: string;
  readonly region?: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
}

export class S3BundleSourceStore implements BundleSourceStore {
  private readonly client: S3Client;

  constructor(private readonly config: S3BundleSourceStoreConfig) {
    this.client = new S3Client({
      region: config.region ?? "auto",
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle ?? config.endpoint !== undefined,
    });
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      if (!result.Body) return "";
      return responseBodyToString(result.Body);
    } catch (err) {
      if (isObjectNotFound(err)) return undefined;
      throw err;
    }
  }
}

export class LocalBundleSourceStore implements BundleSourceStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
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

export class RedisBundleResolver {
  constructor(
    private readonly redis: Redis,
    private readonly sourceStore?: BundleSourceStore,
  ) {}

  async resolveForGame(gameId: string): Promise<BrokerWakeInput | undefined> {
    const game = await getJson<GameRecord>(this.redis, `${GAME_KEY_PREFIX}${gameId}`);
    if (!game) return undefined;
    const bundle = await getJson<BundleRecord>(this.redis, `${BUNDLE_KEY_PREFIX}${game.bundleName}`);
    if (!bundle) return undefined;
    const bundleSource = bundle.source ?? await this.readSourceObject(bundle);
    if (!bundleSource) return undefined;
    return {
      gameId,
      bundleName: bundle.bundleName,
      bundleSource,
      bundleCompatTag: bundle.manifest.compatTagProduced,
      runtimeContractRequired: bundle.manifest.runtimeContractRequired,
      blobCompatTag: game.blobCompatTag,
    };
  }

  private async readSourceObject(bundle: BundleRecord): Promise<string | undefined> {
    if (!bundle.sourceObjectKey || !this.sourceStore) return undefined;
    return this.sourceStore.get(bundle.sourceObjectKey);
  }
}

async function getJson<T>(redis: Redis, key: string): Promise<T | undefined> {
  const raw = await redis.get(key);
  return raw ? (JSON.parse(raw) as T) : undefined;
}

function localObjectPath(root: string, key: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, key);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`object key escapes local root: ${key}`);
  }
  return resolved;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err;
}

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
