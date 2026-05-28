import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  GATEWAY_ENVELOPE_VERSION,
  type ApiGatewayDispatchInput,
  type ConnectedSessionSnapshot,
  type GatewayHttpRequestBody,
} from "@pax-backend/ipc-protocol";
import { startPaxNodeTelemetry } from "@pax-backend/node-telemetry";
import {
  handleReferenceService,
  referenceServiceConfigFromEnv,
  referenceServiceMetricsSnapshot,
  type ReferenceServiceConfig,
  type ReferenceServiceMetricsSnapshot,
} from "@pax-backend/url-services";

startPaxNodeTelemetry({ serviceName: "pax-api-gateway", paxZone: "orchestration" });

import { budgetFromEnv } from "./budgets.mjs";
import { ApiGateway, type ApiGatewayMetricsSnapshot } from "./dispatch.mjs";
import { loadRedisRegistryFromEnv, type ApiKindRegistry } from "./registry.mjs";
import {
  CompositeWireRecordStore,
  FixtureWireRecordStore,
  JsonlWireRecordStore,
  type WireRecordStore,
} from "./record-replay.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

export interface ApiGatewayServerConfig {
  readonly bindHost: string;
  readonly bindPort: number;
  readonly baseUrl: string;
  readonly recordsPath: string;
  readonly replayFixturesPath?: string;
  readonly defaultMode: "live" | "replay";
  readonly providerTimeoutMs: number;
  readonly referenceServices: ReferenceServiceConfig;
}

export interface ApiGatewayServer {
  readonly server: Server;
  readonly gateway: ApiGateway;
  readonly registry: ApiKindRegistry;
  readonly config: ApiGatewayServerConfig;
}

export function configFromEnv(env: NodeJS.ProcessEnv): ApiGatewayServerConfig {
  const bind = parseBind(env["PAX_API_GATEWAY_BIND"] ?? "127.0.0.1:9081");
  const baseUrl = env["PAX_API_GATEWAY_BASE_URL"] ?? `http://${bind.host}:${bind.port}`;
  const recordsPath =
    env["PAX_API_WIRE_RECORDS_PATH"] ?? join(REPO_ROOT, "var", "api-invoke-records.jsonl");
  const replayFixturesPath = readOptionalEnv(env, "PAX_API_REPLAY_FIXTURES_PATH");
  const mode = env["PAX_API_GATEWAY_MODE"] === "replay" ? "replay" : "live";
  return {
    bindHost: bind.host,
    bindPort: bind.port,
    baseUrl,
    recordsPath,
    replayFixturesPath,
    defaultMode: mode,
    providerTimeoutMs: parsePositiveInteger(env["PAX_API_PROVIDER_TIMEOUT_MS"] ?? "30000", 30_000),
    referenceServices: referenceServiceConfigFromEnv(env),
  };
}

export function createApiGatewayServer(
  config: ApiGatewayServerConfig,
): ApiGatewayServer {
  mkdirSync(dirname(config.recordsPath), { recursive: true });
  const registry = loadRedisRegistryFromEnv(process.env, config.baseUrl);
  const gateway = new ApiGateway({
    registry,
    budget: budgetFromEnv(process.env),
    records: wireRecordStoreFromConfig(config),
    defaultMode: config.defaultMode,
    providerTimeoutMs: config.providerTimeoutMs,
  });

  const server = createServer((req, res) => {
    void handleRequest(req, res, gateway, registry, config);
  });

  return { server, gateway, registry, config };
}

function wireRecordStoreFromConfig(config: ApiGatewayServerConfig): WireRecordStore {
  const jsonlStore = new JsonlWireRecordStore(config.recordsPath);
  if (!config.replayFixturesPath) return jsonlStore;
  return new CompositeWireRecordStore(
    [new FixtureWireRecordStore(config.replayFixturesPath), jsonlStore],
    jsonlStore,
  );
}

export async function startApiGatewayServer(
  config = configFromEnv(process.env),
): Promise<ApiGatewayServer> {
  const instance = createApiGatewayServer(config);
  await new Promise<void>((resolveListen) => {
    instance.server.listen(config.bindPort, config.bindHost, resolveListen);
  });
  return instance;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  gateway: ApiGateway,
  registry: ApiKindRegistry,
  config: ApiGatewayServerConfig,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", config.baseUrl);
    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, {
        status: "ok",
        runtime: "api-gateway",
        mode: config.defaultMode,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      writeText(
        res,
        200,
        metricsText(gateway.metricsSnapshot(), referenceServiceMetricsSnapshot()),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/admin/api-kinds") {
      writeJson(res, 200, { ok: true, kinds: await registry.list() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/admin/api-kinds") {
      const body = asApiKindRegistration(await readJson(req));
      try {
        await registry.set(body);
      } catch (err) {
        throw new HttpError(400, "badRequest", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
      writeJson(res, 201, { ok: true, registration: body });
      return;
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/admin/api-kinds/")) {
      const kindName = decodeURIComponent(url.pathname.slice("/admin/api-kinds/".length));
      const deleted = await registry.delete(kindName);
      writeJson(res, deleted ? 200 : 404, { ok: deleted });
      return;
    }

    if (req.method === "POST" && url.pathname === "/invoke") {
      const input = asDispatchInput(await readJson(req));
      writeJson(res, 200, await gateway.invoke(input));
      return;
    }

    if (req.method === "POST" && url.pathname.startsWith("/_url-services/")) {
      assertGatewayEnvelopeVersion(req);
      const result = await handleReferenceService(
        url.pathname,
        asGatewayHttpRequest(await readJson(req)),
        config.referenceServices,
      );
      writeJson(res, result.handled ? result.statusCode : 404, result.body);
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

function assertGatewayEnvelopeVersion(req: IncomingMessage): void {
  const expected = String(GATEWAY_ENVELOPE_VERSION);
  const raw = req.headers["x-gateway-envelope-version"];
  const received = Array.isArray(raw) ? raw[0] : raw;
  if (received !== expected) {
    throw new HttpError(400, "unsupportedGatewayEnvelopeVersion", {
      expected,
      received: received ?? null,
    });
  }
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

function metricsText(
  snapshot: ApiGatewayMetricsSnapshot,
  referenceServices: readonly ReferenceServiceMetricsSnapshot[],
): string {
  const lines = [
    "# HELP pax_api_gateway_invocations_total Total c.api.invoke calls handled by the gateway.",
    "# TYPE pax_api_gateway_invocations_total counter",
    `pax_api_gateway_invocations_total ${snapshot.invocationsTotal}`,
    "# HELP pax_api_gateway_invocations_ok_total Total successful c.api.invoke responses.",
    "# TYPE pax_api_gateway_invocations_ok_total counter",
    `pax_api_gateway_invocations_ok_total ${snapshot.okTotal}`,
    "# HELP pax_api_gateway_invocations_error_total Total c.api.invoke failures by substrate error.",
    "# TYPE pax_api_gateway_invocations_error_total counter",
  ];
  for (const [error, count] of Object.entries(snapshot.errorsTotal)) {
    lines.push(`pax_api_gateway_invocations_error_total{error="${error}"} ${count}`);
  }
  lines.push(
    "# HELP pax_url_service_invocations_total Total reference URL service invokes by kind.",
    "# TYPE pax_url_service_invocations_total counter",
  );
  for (const service of referenceServices) {
    const labels = urlServiceLabels(service.kindName);
    lines.push(`pax_url_service_invocations_total{${labels}} ${service.invocationsTotal}`);
  }
  lines.push(
    "# HELP pax_url_service_errors_total Total reference URL service invokes that returned errors by kind.",
    "# TYPE pax_url_service_errors_total counter",
  );
  for (const service of referenceServices) {
    const labels = urlServiceLabels(service.kindName);
    lines.push(`pax_url_service_errors_total{${labels}} ${service.errorsTotal}`);
  }
  lines.push(
    "# HELP pax_url_service_duration_ms_sum Total reference URL service handler duration in milliseconds by kind.",
    "# TYPE pax_url_service_duration_ms_sum counter",
  );
  for (const service of referenceServices) {
    const labels = urlServiceLabels(service.kindName);
    lines.push(`pax_url_service_duration_ms_sum{${labels}} ${service.durationMsSum}`);
  }
  return `${lines.join("\n")}\n`;
}

function urlServiceLabels(kindName: string): string {
  return `kind="${prometheusLabel(kindName)}"`;
}

function prometheusLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function asDispatchInput(raw: unknown): ApiGatewayDispatchInput {
  const body = asRecord(raw, "dispatch body");
  const kind = readString(body, "kind");
  return {
    kind,
    args: body["args"],
    idempotencyKey: readOptionalString(body, "idempotencyKey"),
    gameId: readString(body, "gameId"),
    traceId: readNullableString(body, "traceId"),
    triggeringSessionId: readNullableString(body, "triggeringSessionId"),
    triggeringJwtClaims: readNullableRecord(body, "triggeringJwtClaims"),
    connectedSessions: readConnectedSessions(body["connectedSessions"]),
    bundleName: readString(body, "bundleName"),
    bundleCompatTag: readString(body, "bundleCompatTag"),
    runId: readString(body, "runId"),
    replayMode: body["replayMode"] === true,
  };
}

function asGatewayHttpRequest(raw: unknown): GatewayHttpRequestBody {
  const body = asRecord(raw, "gateway HTTP body");
  return {
    args: body["args"],
    context: asRecord(
      body["context"],
      "gateway HTTP context",
    ) as unknown as GatewayHttpRequestBody["context"],
  };
}

function asApiKindRegistration(raw: unknown): { kindName: string; url: string } {
  const body = asRecord(raw, "api-kind registration");
  return {
    kindName: readString(body, "kindName"),
    url: readString(body, "url"),
  };
}

function readConnectedSessions(raw: unknown): readonly ConnectedSessionSnapshot[] {
  if (!Array.isArray(raw)) {
    throw new HttpError(400, "badRequest", { field: "connectedSessions" });
  }
  return raw.map((entry) => {
    const record = asRecord(entry, "connected session");
    return {
      sessionId: readString(record, "sessionId"),
      playerId: readString(record, "playerId"),
      connectedAt: readNumber(record, "connectedAt"),
    };
  });
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

function readNullableString(
  record: Readonly<Record<string, unknown>>,
  field: string,
): string | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new HttpError(400, "badRequest", { field, expected: "string or null" });
  }
  return value;
}

function readNullableRecord(
  record: Readonly<Record<string, unknown>>,
  field: string,
): Readonly<Record<string, unknown>> | null {
  const value = record[field];
  if (value === null || value === undefined) return null;
  return asRecord(value, field);
}

function readNumber(record: Readonly<Record<string, unknown>>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "badRequest", { field, expected: "finite number" });
  }
  return value;
}

function readOptionalEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function parseBind(raw: string): { host: string; port: number } {
  if (raw.startsWith("[")) {
    const closeBracket = raw.indexOf("]");
    if (closeBracket <= 1 || raw[closeBracket + 1] !== ":") {
      throw new Error(`invalid PAX_API_GATEWAY_BIND: ${raw}`);
    }
    return parseBindParts(raw.slice(1, closeBracket), raw.slice(closeBracket + 2), raw);
  }

  const lastColon = raw.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === raw.length - 1) {
    throw new Error(`invalid PAX_API_GATEWAY_BIND: ${raw}`);
  }
  return parseBindParts(raw.slice(0, lastColon), raw.slice(lastColon + 1), raw);
}

function parseBindParts(host: string, rawPort: string, raw: string): { host: string; port: number } {
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid PAX_API_GATEWAY_BIND port: ${raw}`);
  }
  return { host, port };
}

function parsePositiveInteger(raw: string, fallback: number): number {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
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
  await startApiGatewayServer(config);
  process.stdout.write(
    `api-gateway listening on http://${config.bindHost}:${config.bindPort} (${config.defaultMode})\n`,
  );
}
