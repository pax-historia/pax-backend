import { setTimeout as sleep } from "node:timers/promises";

import type { GatewayHttpRequestBody, GatewayHttpResponseBody } from "@pax-backend/ipc-protocol";

import { sha256Hex, stableSerialize } from "./envelope.mjs";

export interface ReferenceServiceConfig {
  readonly httpFetchAllowlist: readonly string[];
  readonly delayMaxMs: number;
}

export interface ReferenceServiceResult {
  readonly handled: boolean;
  readonly statusCode: number;
  readonly body: GatewayHttpResponseBody;
}

export async function handleReferenceService(
  pathname: string,
  request: GatewayHttpRequestBody,
  config: ReferenceServiceConfig,
): Promise<ReferenceServiceResult> {
  switch (pathname) {
    case "/_url-services/echo/invoke":
      return ok(request.args);
    case "/_url-services/delay/invoke":
      return delay(request.args, config.delayMaxMs);
    case "/_url-services/http-fetch/invoke":
      return httpFetch(request.args, config.httpFetchAllowlist);
    case "/_url-services/mock-ai.v1/invoke":
      return mockAi(request.args);
    default:
      return {
        handled: false,
        statusCode: 404,
        body: { error: "notFound", detail: { pathname } },
      };
  }
}

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

function ok(result: unknown): ReferenceServiceResult {
  return {
    handled: true,
    statusCode: 200,
    body: { result },
  };
}

async function delay(args: unknown, maxMs: number): Promise<ReferenceServiceResult> {
  const delayMs = clampNumber(readObjectNumber(args, "delayMs") ?? 0, 0, maxMs);
  await sleep(delayMs);
  const result =
    isRecord(args) && Object.prototype.hasOwnProperty.call(args, "result")
      ? args["result"]
      : args;
  return ok(result);
}

async function httpFetch(
  args: unknown,
  allowlist: readonly string[],
): Promise<ReferenceServiceResult> {
  if (!isRecord(args) || typeof args["url"] !== "string") {
    return badRequest("http.fetch.v1 requires args.url");
  }
  let url: URL;
  try {
    url = new URL(args["url"]);
  } catch {
    return badRequest("http.fetch.v1 args.url must be an absolute URL");
  }
  if (!isAllowedHttpFetchTarget(url, allowlist)) {
    return {
      handled: true,
      statusCode: 403,
      body: {
        error: "targetNotAllowed",
        detail: { url: url.toString(), allowlist },
      },
    };
  }

  const method = typeof args["method"] === "string" ? args["method"].toUpperCase() : "GET";
  const headers = isRecord(args["headers"]) ? stringifyHeaders(args["headers"]) : undefined;
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : typeof args["body"] === "string"
        ? args["body"]
        : args["body"] === undefined
          ? undefined
          : JSON.stringify(args["body"]);

  const response = await fetch(url, { method, headers, body });
  return ok({
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text(),
  });
}

function mockAi(args: unknown): ReferenceServiceResult {
  const fingerprint = sha256Hex(stableSerialize(args)).slice(0, 16);
  return ok({
    id: `mock-ai.v1:${fingerprint}`,
    model: "mock-ai.v1",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: `mock-ai.v1 response ${fingerprint}`,
        },
        finishReason: "stop",
      },
    ],
    usage: {
      inputTokens: estimateTokenCount(args),
      outputTokens: 4,
    },
  });
}

function badRequest(message: string): ReferenceServiceResult {
  return {
    handled: true,
    statusCode: 400,
    body: { error: "badRequest", detail: { message } },
  };
}

function isAllowedHttpFetchTarget(url: URL, allowlist: readonly string[]): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (allowlist.includes("*")) return true;
  return allowlist.some((entry) => {
    try {
      const parsed = new URL(entry.includes("://") ? entry : `https://${entry}`);
      return parsed.hostname === url.hostname && (parsed.port === "" || parsed.port === url.port);
    } catch {
      return entry === url.hostname || entry === url.origin;
    }
  });
}

function stringifyHeaders(headers: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function readObjectNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const item = value[key];
  return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function estimateTokenCount(value: unknown): number {
  return Math.max(1, Math.ceil(stableSerialize(value).length / 4));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
