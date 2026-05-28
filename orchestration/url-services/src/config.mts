import type { ReferenceServiceConfig } from "./types.mjs";

export function referenceServiceConfigFromEnv(env: NodeJS.ProcessEnv): ReferenceServiceConfig {
  const allowlist = (env["PAX_HTTP_FETCH_ALLOWLIST"] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const maxDelay = Number.parseInt(env["PAX_DELAY_SERVICE_MAX_MS"] ?? "30000", 10);
  return {
    httpFetchAllowlist: allowlist,
    delayMaxMs: Number.isFinite(maxDelay) && maxDelay > 0 ? maxDelay : 30_000,
  };
}
