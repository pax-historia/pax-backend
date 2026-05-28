import { readFileSync } from "node:fs";

export interface ApiKindRegistration {
  readonly kindName: string;
  readonly url: string;
}

export interface ApiKindRegistry {
  get(kindName: string): string | undefined;
  list(): readonly ApiKindRegistration[];
  set(registration: ApiKindRegistration): void;
  delete(kindName: string): boolean;
}

export class InMemoryApiKindRegistry implements ApiKindRegistry {
  readonly #registrations = new Map<string, string>();

  constructor(registrations: readonly ApiKindRegistration[] = []) {
    for (const registration of registrations) {
      this.set(registration);
    }
  }

  get(kindName: string): string | undefined {
    return this.#registrations.get(kindName);
  }

  list(): readonly ApiKindRegistration[] {
    return Array.from(this.#registrations.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([kindName, url]) => ({ kindName, url }));
  }

  set(registration: ApiKindRegistration): void {
    assertApiKindRegistration(registration);
    this.#registrations.set(registration.kindName, registration.url);
  }

  delete(kindName: string): boolean {
    return this.#registrations.delete(kindName);
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
