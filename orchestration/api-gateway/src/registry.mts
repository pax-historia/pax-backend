import { readFileSync } from "node:fs";

import { Redis } from "ioredis";

import {
  API_KIND_KEY_PREFIX,
  type ApiKindRegistration,
} from "@pax-backend/ipc-protocol";

export type { ApiKindRegistration } from "@pax-backend/ipc-protocol";

export interface ApiKindRegistry {
  get(kindName: string): Promise<string | undefined>;
  list(): Promise<readonly ApiKindRegistration[]>;
  set(registration: ApiKindRegistration): Promise<void>;
  delete(kindName: string): Promise<boolean>;
}

export class InMemoryApiKindRegistry implements ApiKindRegistry {
  readonly #registrations = new Map<string, string>();

  constructor(registrations: readonly ApiKindRegistration[] = []) {
    for (const registration of registrations) {
      assertApiKindRegistration(registration);
      this.#registrations.set(registration.kindName, registration.url);
    }
  }

  async get(kindName: string): Promise<string | undefined> {
    return this.#registrations.get(kindName);
  }

  async list(): Promise<readonly ApiKindRegistration[]> {
    return Array.from(this.#registrations.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kindName, url]) => ({ kindName, url }));
  }

  async set(registration: ApiKindRegistration): Promise<void> {
    assertApiKindRegistration(registration);
    this.#registrations.set(registration.kindName, registration.url);
  }

  async delete(kindName: string): Promise<boolean> {
    return this.#registrations.delete(kindName);
  }
}

export class RedisApiKindRegistry implements ApiKindRegistry {
  readonly #redis: Redis;
  readonly #fallback: InMemoryApiKindRegistry;

  constructor(redis: Redis, fallback: InMemoryApiKindRegistry) {
    this.#redis = redis;
    this.#fallback = fallback;
  }

  async get(kindName: string): Promise<string | undefined> {
    const raw = await this.#redis.get(`${API_KIND_KEY_PREFIX}${kindName}`);
    if (raw) return (JSON.parse(raw) as ApiKindRegistration).url;
    return this.#fallback.get(kindName);
  }

  async list(): Promise<readonly ApiKindRegistration[]> {
    const fallback = await this.#fallback.list();
    const operator = await this.#listOperatorRegistrations();
    const merged = new Map<string, ApiKindRegistration>();
    for (const registration of fallback) merged.set(registration.kindName, registration);
    for (const registration of operator) merged.set(registration.kindName, registration);
    return Array.from(merged.values()).sort((a, b) => a.kindName.localeCompare(b.kindName));
  }

  async set(registration: ApiKindRegistration): Promise<void> {
    assertApiKindRegistration(registration);
    await this.#redis.set(
      `${API_KIND_KEY_PREFIX}${registration.kindName}`,
      JSON.stringify({ ...registration, registeredAt: registration.registeredAt ?? Date.now() }),
    );
  }

  async delete(kindName: string): Promise<boolean> {
    return (await this.#redis.del(`${API_KIND_KEY_PREFIX}${kindName}`)) > 0;
  }

  async #listOperatorRegistrations(): Promise<readonly ApiKindRegistration[]> {
    const keys = await scanKeys(this.#redis, `${API_KIND_KEY_PREFIX}*`);
    if (keys.length === 0) return [];
    const raws = await this.#redis.mget(...keys);
    return raws.flatMap((raw) => (raw ? [JSON.parse(raw) as ApiKindRegistration] : []));
  }
}

export function referenceKindRegistrations(baseUrl: string): readonly ApiKindRegistration[] {
  const normalized = baseUrl.replace(/\/+$/, "");
  return [
    { kindName: "echo.v1", url: `${normalized}/_url-services/echo/invoke` },
    { kindName: "delay.v1", url: `${normalized}/_url-services/delay/invoke` },
    { kindName: "http.fetch.v1", url: `${normalized}/_url-services/http-fetch/invoke` },
    { kindName: "mock-ai.v1", url: `${normalized}/_url-services/mock-ai.v1/invoke` },
  ];
}

export function loadRegistryFromEnv(
  env: NodeJS.ProcessEnv,
  fallbackBaseUrl: string,
): InMemoryApiKindRegistry {
  const registrations = [
    ...referenceKindRegistrations(fallbackBaseUrl),
    ...loadOperatorRegistrations(env),
  ];
  return new InMemoryApiKindRegistry(registrations);
}

export function loadRedisRegistryFromEnv(
  env: NodeJS.ProcessEnv,
  fallbackBaseUrl: string,
): RedisApiKindRegistry {
  return new RedisApiKindRegistry(
    new Redis(env["REDIS_URL"] ?? "redis://127.0.0.1:6379", {
      lazyConnect: false,
      maxRetriesPerRequest: null,
    }),
    loadRegistryFromEnv(env, fallbackBaseUrl),
  );
}

function loadOperatorRegistrations(env: NodeJS.ProcessEnv): readonly ApiKindRegistration[] {
  const json = env["PAX_API_KIND_REGISTRY_JSON"];
  if (json && json.trim().length > 0) {
    return parseRegistryConfig(JSON.parse(json));
  }

  const file = env["PAX_API_KIND_REGISTRY_FILE"];
  if (file && file.trim().length > 0) {
    return parseRegistryConfig(JSON.parse(readFileSync(file, "utf8")));
  }

  return [];
}

function parseRegistryConfig(raw: unknown): readonly ApiKindRegistration[] {
  if (Array.isArray(raw)) {
    return raw.map((entry) => {
      if (!entry || typeof entry !== "object") {
        throw new Error("PAX_API_KIND_REGISTRY entry must be an object");
      }
      const candidate = entry as Partial<ApiKindRegistration>;
      const registration = {
        kindName: String(candidate.kindName ?? ""),
        url: String(candidate.url ?? ""),
      };
      assertApiKindRegistration(registration);
      return registration;
    });
  }

  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([kindName, url]) => {
      const registration = { kindName, url: String(url) };
      assertApiKindRegistration(registration);
      return registration;
    });
  }

  throw new Error("PAX_API_KIND_REGISTRY must be an object map or array");
}

function assertApiKindRegistration(registration: ApiKindRegistration): void {
  if (!isApiKindName(registration.kindName)) {
    throw new Error(`invalid API kind name: ${registration.kindName}`);
  }
  try {
    const url = new URL(registration.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("URL must be http or https");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`invalid URL for API kind ${registration.kindName}: ${message}`);
  }
}

function isApiKindName(kindName: string): boolean {
  return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*\.v[0-9]+$/.test(kindName);
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
