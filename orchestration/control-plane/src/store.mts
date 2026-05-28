import { Redis } from "ioredis";

import {
  ALLOWED_PLAYERS_KEY_PREFIX,
  BLOB_KEY_PREFIX,
  BUNDLE_KEY_PREFIX,
  type BundleRecord,
  GAME_KEY_PREFIX,
  type GameRecord,
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

  async putStorageRaw(
    gameId: string,
    tier: "state" | "blob",
    raw: string,
  ): Promise<void> {
    await this.redis.set(storageKey(gameId, tier), raw);
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
