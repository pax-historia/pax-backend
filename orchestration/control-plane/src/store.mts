import { Redis } from "ioredis";

import {
  ALLOWED_PLAYERS_KEY_PREFIX,
  API_KIND_KEY_PREFIX,
  type ApiKindRegistration,
  BLOB_KEY_PREFIX,
  BUNDLE_KEY_PREFIX,
  type BundleRecord,
  GAME_KEY_PREFIX,
  type GameRecord,
  SHARD_DRAIN_KEY_PREFIX,
  SHARD_REGISTRY_KEY_PREFIX,
  SHARD_REGISTRY_TTL_SECONDS,
  type ShardRegistration,
  STATE_KEY_PREFIX,
} from "@pax-backend/ipc-protocol";

export class ControlPlaneStore {
  constructor(readonly redis: Redis) {}

  async getBundle(bundleName: string): Promise<BundleRecord | undefined> {
    return getJson<BundleRecord>(this.redis, `${BUNDLE_KEY_PREFIX}${bundleName}`);
  }

  async putBundleWriteOnce(record: BundleRecord): Promise<boolean> {
    const result = await this.redis.set(
      `${BUNDLE_KEY_PREFIX}${record.bundleName}`,
      JSON.stringify(record),
      "NX",
    );
    return result === "OK";
  }

  async deleteBundleIfUnused(
    bundleName: string,
  ): Promise<
    | { readonly status: "deleted" }
    | { readonly status: "missing" }
    | { readonly status: "inUse"; readonly gameIds: readonly string[] }
  > {
    const referencingGameIds = (await this.listGames())
      .filter((game) => game.bundleName === bundleName)
      .map((game) => game.gameId)
      .sort();
    if (referencingGameIds.length > 0) {
      return { status: "inUse", gameIds: referencingGameIds };
    }
    const deleted = await this.redis.del(`${BUNDLE_KEY_PREFIX}${bundleName}`);
    return deleted > 0 ? { status: "deleted" } : { status: "missing" };
  }

  async getGame(gameId: string): Promise<GameRecord | undefined> {
    return getJson<GameRecord>(this.redis, `${GAME_KEY_PREFIX}${gameId}`);
  }

  async putGame(record: GameRecord): Promise<void> {
    await this.redis.set(`${GAME_KEY_PREFIX}${record.gameId}`, JSON.stringify(record));
  }

  async putGameWriteOnce(record: GameRecord): Promise<boolean> {
    const result = await this.redis.set(
      `${GAME_KEY_PREFIX}${record.gameId}`,
      JSON.stringify(record),
      "NX",
    );
    return result === "OK";
  }

  async deleteGame(gameId: string): Promise<boolean> {
    const deletedGame = await this.redis.del(`${GAME_KEY_PREFIX}${gameId}`);
    if (deletedGame === 0) return false;
    await this.redis.del(
      `${ALLOWED_PLAYERS_KEY_PREFIX}${gameId}`,
      storageKey(gameId, "state"),
      storageKey(gameId, "blob"),
    );
    return true;
  }

  async listGames(): Promise<readonly GameRecord[]> {
    const keys = await scanKeys(this.redis, `${GAME_KEY_PREFIX}*`);
    if (keys.length === 0) return [];
    const raws = await this.redis.mget(...keys);
    return raws.flatMap((raw) => (raw ? [JSON.parse(raw) as GameRecord] : []));
  }

  async addAllowedPlayer(gameId: string, playerId: string): Promise<void> {
    await this.redis.sadd(`${ALLOWED_PLAYERS_KEY_PREFIX}${gameId}`, playerId);
  }

  async removeAllowedPlayer(gameId: string, playerId: string): Promise<boolean> {
    return (await this.redis.srem(`${ALLOWED_PLAYERS_KEY_PREFIX}${gameId}`, playerId)) > 0;
  }

  async listAllowedPlayers(gameId: string): Promise<readonly string[]> {
    return (await this.redis.smembers(`${ALLOWED_PLAYERS_KEY_PREFIX}${gameId}`)).sort();
  }

  async removePlayerFromAllAllowedLists(playerId: string): Promise<readonly string[]> {
    const keys = await scanKeys(this.redis, `${ALLOWED_PLAYERS_KEY_PREFIX}*`);
    if (keys.length === 0) return [];
    const tx = this.redis.multi();
    for (const key of keys) tx.srem(key, playerId);
    const results = await tx.exec();
    if (!results) return [];
    return keys
      .filter((_key, index) => {
        const result = results[index];
        return Number(result?.[1] ?? 0) > 0;
      })
      .map((key) => key.slice(ALLOWED_PLAYERS_KEY_PREFIX.length))
      .sort();
  }

  async listApiKinds(): Promise<readonly ApiKindRegistration[]> {
    const keys = await scanKeys(this.redis, `${API_KIND_KEY_PREFIX}*`);
    if (keys.length === 0) return [];
    const raws = await this.redis.mget(...keys);
    return raws
      .flatMap((raw) => (raw ? [JSON.parse(raw) as ApiKindRegistration] : []))
      .sort((a, b) => a.kindName.localeCompare(b.kindName));
  }

  async getApiKind(kindName: string): Promise<ApiKindRegistration | undefined> {
    return getJson<ApiKindRegistration>(this.redis, `${API_KIND_KEY_PREFIX}${kindName}`);
  }

  async putApiKind(registration: ApiKindRegistration): Promise<void> {
    await this.redis.set(
      `${API_KIND_KEY_PREFIX}${registration.kindName}`,
      JSON.stringify(registration),
    );
  }

  async deleteApiKind(kindName: string): Promise<boolean> {
    return (await this.redis.del(`${API_KIND_KEY_PREFIX}${kindName}`)) > 0;
  }

  async listShards(): Promise<readonly ShardRegistration[]> {
    const keys = await scanKeys(this.redis, `${SHARD_REGISTRY_KEY_PREFIX}*`);
    if (keys.length === 0) return [];
    const raws = await this.redis.mget(...keys);
    return raws.flatMap((raw) => (raw ? [JSON.parse(raw) as ShardRegistration] : []));
  }

  async getShard(shardId: string): Promise<ShardRegistration | undefined> {
    return getJson<ShardRegistration>(this.redis, `${SHARD_REGISTRY_KEY_PREFIX}${shardId}`);
  }

  async setShardDrain(
    shardId: string,
    draining: boolean,
  ): Promise<ShardRegistration | undefined> {
    const shard = await this.getShard(shardId);
    if (!shard) return undefined;
    if (draining) {
      await this.redis.set(`${SHARD_DRAIN_KEY_PREFIX}${shardId}`, "true");
    } else {
      await this.redis.del(`${SHARD_DRAIN_KEY_PREFIX}${shardId}`);
    }
    const updated: ShardRegistration = {
      ...shard,
      acceptingWakes: !draining,
      lastSeenAt: Date.now(),
    };
    await this.redis.set(
      `${SHARD_REGISTRY_KEY_PREFIX}${shardId}`,
      JSON.stringify(updated),
      "EX",
      SHARD_REGISTRY_TTL_SECONDS,
    );
    return updated;
  }

  async putStorageRaw(
    gameId: string,
    tier: "state" | "blob",
    raw: string,
  ): Promise<void> {
    await this.redis.set(storageKey(gameId, tier), raw);
  }

  async getStorageRaw(
    gameId: string,
    tier: "state" | "blob",
  ): Promise<string | undefined> {
    return (await this.redis.get(storageKey(gameId, tier))) ?? undefined;
  }
}

async function getJson<T>(redis: Redis, key: string): Promise<T | undefined> {
  const raw = await redis.get(key);
  return raw ? (JSON.parse(raw) as T) : undefined;
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  let cursor = "0";
  const keys: string[] = [];
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

function storageKey(gameId: string, tier: "state" | "blob"): string {
  return `${tier === "state" ? STATE_KEY_PREFIX : BLOB_KEY_PREFIX}${gameId}`;
}
