import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ConnectedSessionSnapshot,
  GatewayHttpRequestBody,
  GatewayHttpResponseBody,
} from "@pax-backend/ipc-protocol";

export interface BillingMockServerConfig {
  readonly bindHost: string;
  readonly bindPort: number;
}

export interface AccountEvent {
  readonly eventId: string;
  readonly action: "grant" | "charge" | "refund";
  readonly playerId: string;
  readonly amount: number;
  readonly at: number;
  readonly gameId: string;
  readonly sessionId: string | null;
  readonly idempotencyKey: string | null;
  readonly relatedEventId?: string;
  readonly memo?: string;
}

export interface AccountSnapshot {
  readonly playerId: string;
  readonly credits: number;
  readonly updatedAt: number;
  readonly events: readonly AccountEvent[];
}

export type BillingMockResult = BillingMockApprovedResult | BillingMockDeniedResult;
export type BillingMockActionName = "quote" | "grant" | "charge" | "refund";

export interface BillingMockResultBase {
  readonly approved: boolean;
  readonly action: BillingMockActionName;
  readonly replayed: boolean;
  readonly connectedSessions: readonly ConnectedSessionSnapshot[];
}

export interface BillingMockApprovedResult extends BillingMockResultBase {
  readonly approved: true;
  readonly account: AccountSnapshot;
  readonly event?: AccountEvent;
}

export interface BillingMockDeniedResult extends BillingMockResultBase {
  readonly approved: false;
  readonly error: string;
  readonly detail?: unknown;
  readonly account?: AccountSnapshot;
}

export interface BillingMockHttpResult {
  readonly statusCode: number;
  readonly body: GatewayHttpResponseBody;
}

type BillingMockAction = QuoteAction | GrantAction | ChargeAction | RefundAction;

interface QuoteAction {
  readonly action: "quote";
  readonly playerId: string;
}

interface GrantAction {
  readonly action: "grant";
  readonly playerId: string;
  readonly amount: number;
  readonly memo?: string;
}

interface ChargeAction {
  readonly action: "charge";
  readonly playerId: string;
  readonly amount: number;
  readonly memo?: string;
  readonly allowOffline: boolean;
}

interface RefundAction {
  readonly action: "refund";
  readonly eventId: string;
  readonly memo?: string;
}

export class BillingMockStore {
  readonly #accounts = new Map<string, AccountSnapshot>();
  readonly #events = new Map<string, AccountEvent>();
  readonly #refundedEventIds = new Set<string>();
  readonly #idempotentResults = new Map<string, BillingMockResult>();
  #nextEventSeq = 1;

  invoke(request: GatewayHttpRequestBody): BillingMockHttpResult {
    let action: BillingMockAction;
    try {
      action = parseBillingMockAction(request.args);
    } catch (err) {
      return {
        statusCode: 400,
        body: {
          error: "badRequest",
          detail: err instanceof RequestShapeError ? err.detail : String(err),
        },
      };
    }

    const idempotencyKey = request.context.idempotencyKey;
    if (idempotencyKey) {
      const cached = this.#idempotentResults.get(idempotencyKey);
      if (cached) {
        return {
          statusCode: 200,
          body: { result: markReplayed(cached) },
        };
      }
    }

    const result = this.#apply(action, request);
    if (idempotencyKey) this.#idempotentResults.set(idempotencyKey, result);
    return {
      statusCode: 200,
      body: { result },
    };
  }

  quote(playerId: string): AccountSnapshot {
    return this.#account(playerId, Date.now());
  }

  reset(): void {
    this.#accounts.clear();
    this.#events.clear();
    this.#refundedEventIds.clear();
    this.#idempotentResults.clear();
    this.#nextEventSeq = 1;
  }

  #apply(action: BillingMockAction, request: GatewayHttpRequestBody): BillingMockResult {
    switch (action.action) {
      case "quote":
        return this.#approve(action, request, this.#account(action.playerId, Date.now()));
      case "grant":
        return this.#grant(action, request);
      case "charge":
        return this.#charge(action, request);
      case "refund":
        return this.#refund(action, request);
    }
    return assertNever(action);
  }

  #grant(action: GrantAction, request: GatewayHttpRequestBody): BillingMockResult {
    const at = Date.now();
    const current = this.#account(action.playerId, at);
    const event = this.#event(action, request, at);
    const next = this.#saveAccount({
      ...current,
      credits: current.credits + action.amount,
      updatedAt: at,
      events: appendEvent(current.events, event),
    });
    this.#events.set(event.eventId, event);
    return this.#approve(action, request, next, event);
  }

  #charge(action: ChargeAction, request: GatewayHttpRequestBody): BillingMockResult {
    const at = Date.now();
    const account = this.#account(action.playerId, at);
    const connectedSession = findConnectedSession(
      request.context.connectedSessions,
      action.playerId,
      request.context.triggeringSessionId,
    );
    if (!connectedSession && !action.allowOffline) {
      return this.#deny(action, request, "playerNotConnected", {
        playerId: action.playerId,
        connectedSessions: request.context.connectedSessions,
      }, account);
    }
    if (isSpectator(request.context.triggeringJwtClaims)) {
      return this.#deny(action, request, "spectatorDenied", {
        triggeringSessionId: request.context.triggeringSessionId,
      }, account);
    }
    if (account.credits < action.amount) {
      return this.#deny(action, request, "insufficientCredits", {
        requested: action.amount,
        available: account.credits,
      }, account);
    }

    const event = this.#event(action, request, at);
    const next = this.#saveAccount({
      ...account,
      credits: account.credits - action.amount,
      updatedAt: at,
      events: appendEvent(account.events, event),
    });
    this.#events.set(event.eventId, event);
    return this.#approve(action, request, next, event);
  }

  #refund(action: RefundAction, request: GatewayHttpRequestBody): BillingMockResult {
    const original = this.#events.get(action.eventId);
    if (!original || original.action !== "charge") {
      return this.#deny(action, request, "chargeEventNotFound", { eventId: action.eventId });
    }
    const at = Date.now();
    const account = this.#account(original.playerId, at);
    if (this.#refundedEventIds.has(original.eventId)) {
      return this.#deny(action, request, "alreadyRefunded", { eventId: original.eventId }, account);
    }

    const event = this.#event(
      {
        action: "refund",
        playerId: original.playerId,
        amount: original.amount,
        memo: action.memo,
        relatedEventId: original.eventId,
      },
      request,
      at,
    );
    const next = this.#saveAccount({
      ...account,
      credits: account.credits + original.amount,
      updatedAt: at,
      events: appendEvent(account.events, event),
    });
    this.#refundedEventIds.add(original.eventId);
    this.#events.set(event.eventId, event);
    return this.#approve(action, request, next, event);
  }

  #event(
    action:
      | GrantAction
      | ChargeAction
      | (RefundAction & {
          readonly playerId: string;
          readonly amount: number;
          readonly relatedEventId: string;
        }),
    request: GatewayHttpRequestBody,
    at: number,
  ): AccountEvent {
    return {
      eventId: `billing_mock_evt_${this.#nextEventSeq++}`,
      action: action.action,
      playerId: action.playerId,
      amount: action.amount,
      at,
      gameId: request.context.gameId,
      sessionId: request.context.triggeringSessionId,
      idempotencyKey: request.context.idempotencyKey,
      relatedEventId: "relatedEventId" in action ? action.relatedEventId : undefined,
      memo: action.memo,
    };
  }

  #approve(
    action: BillingMockAction,
    request: GatewayHttpRequestBody,
    account: AccountSnapshot,
    event?: AccountEvent,
  ): BillingMockApprovedResult {
    return {
      approved: true,
      action: action.action,
      replayed: false,
      connectedSessions: request.context.connectedSessions,
      account,
      event,
    };
  }

  #deny(
    action: BillingMockAction,
    request: GatewayHttpRequestBody,
    error: string,
    detail?: unknown,
    account?: AccountSnapshot,
  ): BillingMockDeniedResult {
    return {
      approved: false,
      action: action.action,
      replayed: false,
      connectedSessions: request.context.connectedSessions,
      error,
      detail,
      account,
    };
  }

  #account(playerId: string, at: number): AccountSnapshot {
    const existing = this.#accounts.get(playerId);
    if (existing) return existing;
    const account: AccountSnapshot = {
      playerId,
      credits: 0,
      updatedAt: at,
      events: [],
    };
    this.#accounts.set(playerId, account);
    return account;
  }

  #saveAccount(account: AccountSnapshot): AccountSnapshot {
    this.#accounts.set(account.playerId, account);
    return account;
  }
}

const defaultStore = new BillingMockStore();

export function handleBillingMockInvoke(
  request: GatewayHttpRequestBody,
  store = defaultStore,
): BillingMockHttpResult {
  return store.invoke(request);
}

export function billingMockConfigFromEnv(env: NodeJS.ProcessEnv): BillingMockServerConfig {
  const bind = parseBind(env["PAX_BILLING_MOCK_BIND"] ?? "127.0.0.1:9091");
  return {
    bindHost: bind.host,
    bindPort: bind.port,
  };
}

export function createBillingMockServer(store = defaultStore): Server {
  return createServer((req, res) => {
    void handleHttpRequest(req, res, store);
  });
}

export async function startBillingMockServer(
  config = billingMockConfigFromEnv(process.env),
  store = defaultStore,
): Promise<Server> {
  const server = createBillingMockServer(store);
  await new Promise<void>((resolveListen) => {
    server.listen(config.bindPort, config.bindHost, resolveListen);
  });
  return server;
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: BillingMockStore,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://billing-mock.local");
    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, { status: "ok", service: "billing-mock.v1" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/invoke") {
      const result = handleBillingMockInvoke(asGatewayHttpRequest(await readJson(req)), store);
      writeJson(res, result.statusCode, result.body);
      return;
    }
    if (req.method === "POST" && url.pathname === "/admin/reset") {
      store.reset();
      writeJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/admin/accounts/")) {
      const playerId = decodeURIComponent(url.pathname.slice("/admin/accounts/".length));
      writeJson(res, 200, { ok: true, account: store.quote(playerId) });
      return;
    }
    writeJson(res, 404, { error: "notFound" });
  } catch (err) {
    writeJson(res, 400, {
      error: "badRequest",
      detail: err instanceof Error ? err.message : String(err),
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
  return JSON.parse(raw);
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

function parseBillingMockAction(raw: unknown): BillingMockAction {
  const body = asRecord(raw, "args");
  const action = readString(body, "action");
  switch (action) {
    case "quote":
      return {
        action,
        playerId: readString(body, "playerId"),
      };
    case "grant":
      return {
        action,
        playerId: readString(body, "playerId"),
        amount: readPositiveAmount(body, "amount"),
        memo: readOptionalString(body, "memo"),
      };
    case "charge":
      return {
        action,
        playerId: readString(body, "playerId"),
        amount: readPositiveAmount(body, "amount"),
        memo: readOptionalString(body, "memo"),
        allowOffline: body["allowOffline"] === true,
      };
    case "refund":
      return {
        action,
        eventId: readString(body, "eventId"),
        memo: readOptionalString(body, "memo"),
      };
    default:
      throw new RequestShapeError({ field: "action", expected: "quote | grant | charge | refund" });
  }
}

function asGatewayHttpRequest(raw: unknown): GatewayHttpRequestBody {
  const body = asRecord(raw, "gateway body");
  const context = asRecord(body["context"], "context");
  return {
    args: body["args"],
    context: {
      gameId: readString(context, "gameId"),
      triggeringSessionId: readNullableString(context, "triggeringSessionId"),
      triggeringJwtClaims: readNullableRecord(context, "triggeringJwtClaims"),
      connectedSessions: readConnectedSessions(context["connectedSessions"]),
      bundleName: readString(context, "bundleName"),
      bundleCompatTag: readString(context, "bundleCompatTag"),
      runId: readString(context, "runId"),
      idempotencyKey: readNullableString(context, "idempotencyKey"),
    },
  };
}

function readConnectedSessions(raw: unknown): readonly ConnectedSessionSnapshot[] {
  if (!Array.isArray(raw)) {
    throw new RequestShapeError({ field: "connectedSessions", expected: "array" });
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

function findConnectedSession(
  sessions: readonly ConnectedSessionSnapshot[],
  playerId: string,
  preferredSessionId: string | null,
): ConnectedSessionSnapshot | undefined {
  const matchingPlayerSessions = sessions.filter((session) => session.playerId === playerId);
  if (preferredSessionId) {
    return matchingPlayerSessions.find((session) => session.sessionId === preferredSessionId);
  }
  return matchingPlayerSessions[0];
}

function isSpectator(claims: Readonly<Record<string, unknown>> | null): boolean {
  if (!claims) return false;
  return claims["role"] === "spectator" || claims["spectator"] === true;
}

function appendEvent(
  events: readonly AccountEvent[],
  event: AccountEvent,
): readonly AccountEvent[] {
  return [...events.slice(-19), event];
}

function markReplayed(result: BillingMockResult): BillingMockResult {
  return { ...result, replayed: true };
}

function assertNever(value: never): never {
  throw new Error(`unhandled billing-mock action: ${JSON.stringify(value)}`);
}

function asRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RequestShapeError({ message: `${label} must be an object` });
  }
  return raw as Record<string, unknown>;
}

function readString(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new RequestShapeError({ field, expected: "non-empty string" });
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
    throw new RequestShapeError({ field, expected: "non-empty string" });
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
    throw new RequestShapeError({ field, expected: "string or null" });
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
    throw new RequestShapeError({ field, expected: "finite number" });
  }
  return value;
}

function readPositiveAmount(record: Readonly<Record<string, unknown>>, field: string): number {
  const value = readNumber(record, field);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RequestShapeError({ field, expected: "positive integer" });
  }
  return value;
}

function parseBind(raw: string): { host: string; port: number } {
  const lastColon = raw.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === raw.length - 1) {
    throw new Error(`invalid PAX_BILLING_MOCK_BIND: ${raw}`);
  }
  const host = raw.slice(0, lastColon);
  const port = Number.parseInt(raw.slice(lastColon + 1), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid PAX_BILLING_MOCK_BIND port: ${raw}`);
  }
  return { host, port };
}

class RequestShapeError extends Error {
  constructor(readonly detail: unknown) {
    super("badRequest");
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const config = billingMockConfigFromEnv(process.env);
  await startBillingMockServer(config);
  process.stdout.write(
    `billing-mock.v1 listening on http://${config.bindHost}:${config.bindPort}\n`,
  );
}
