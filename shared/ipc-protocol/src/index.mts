// The substrate IPC protocol — the cross-zone wire contract.
//
// One integer version (Axis A in the README's versioning matrix). The shard's
// runtimeContractsSupported [min, max] is checked against the bundle's
// runtimeContractRequired by the placement router (guarantee #16). Payload
// shapes are fixed by this version; no in-band version field on payloads.
//
// For the smoke milestone we ship version 1 and the first vertical channels:
// websocket send, structured logs, voluntary sleep, and api.invoke. The rest
// are listed in the README § "Communication channels" and slot in as later
// steps fill them.

export const IPC_VERSION = 1 as const;
export const RUNTIME_CONTRACT_VERSION = 1 as const;

// ----- Redis key prefixes + TTLs (router/shard agreement) ----------------

export const ACTIVE_GAMES_KEY_PREFIX = "active_games:" as const;
export const SHARD_REGISTRY_KEY_PREFIX = "shards:" as const;
export const PLACEMENT_RECENT_WAKES_KEY_PREFIX = "placement_recent_wakes:" as const;
export const BUNDLE_KEY_PREFIX = "bundles:" as const;
export const GAME_KEY_PREFIX = "games:" as const;

export const SHARD_REGISTRY_TTL_SECONDS = 45 as const;
export const ACTIVE_GAME_TTL_SECONDS = 3600 as const;
export const PLACEMENT_RECENT_WAKES_TTL_SECONDS = 45 as const;

// ----- IPC envelope ------------------------------------------------------

export interface IpcEnvelope<T extends string = string, P = unknown> {
  readonly version: typeof IPC_VERSION;
  readonly type: T;
  readonly payload: P;
  readonly requestId?: string;
}

export function envelope<T extends string, P>(
  type: T,
  payload: P,
  requestId?: string,
): IpcEnvelope<T, P> {
  return requestId === undefined
    ? { version: IPC_VERSION, type, payload }
    : { version: IPC_VERSION, type, payload, requestId };
}

// ----- Lifecycle payloads (parent → child) -------------------------------

export type WakeReason =
  | "cold-start"
  | "reconnect"
  | "cold-restart-after-crash"
  | "cold-restart-after-eviction"
  | "cold-restart-after-shard-loss"
  | "upgrade";

export interface OnWakePayload {
  readonly reason: WakeReason;
  readonly runId: string;
  readonly bundleName: string;
  readonly bundleCompatTag: string;
  readonly blobCompatTag?: string;
  readonly state?: unknown;
  readonly blob?: unknown;
}

export interface OnSleepPayload {
  readonly deadline: number;
  readonly reason: "evicted" | "shutdown" | "upgrade" | "requestedBySleep";
}

export interface OnPlayerConnectPayload {
  readonly playerId: string;
  readonly sessionId: string;
  readonly jwtClaims: Readonly<Record<string, unknown>>;
  readonly connectedAt: number;
}

export type DisconnectReason =
  | "left"
  | "timedOut"
  | "removedFromAllowedPlayers"
  | "shardEvicted"
  | "gameDeleted";

export interface OnPlayerDisconnectPayload {
  readonly playerId: string;
  readonly sessionId: string;
  readonly reason: DisconnectReason;
}

export interface OnPlayerMessagePayload {
  readonly playerId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly body: unknown;
}

export interface OnCapacityWarningPayload {
  readonly budget: string;
  readonly currentUsage: number;
  readonly limit: number;
}

// ----- External API channel + gateway envelope --------------------------

export const GATEWAY_ENVELOPE_VERSION = 1 as const;

export type ApiInvokeError =
  | "kindUnknown"
  | "providerError"
  | "apiRateExceeded"
  | "replayCoverageGap";

export interface ApiInvokeRequest {
  readonly kind: string;
  readonly args: unknown;
  readonly idempotencyKey?: string;
}

export type ApiInvokeResponse =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly error: ApiInvokeError;
      readonly detail?: unknown;
    };

export interface ConnectedSessionSnapshot {
  readonly sessionId: string;
  readonly playerId: string;
  readonly connectedAt: number;
}

export interface GatewayInvokeContext {
  readonly gameId: string;
  readonly triggeringSessionId: string | null;
  readonly triggeringJwtClaims: Readonly<Record<string, unknown>> | null;
  readonly connectedSessions: readonly ConnectedSessionSnapshot[];
  readonly bundleName: string;
  readonly bundleCompatTag: string;
  readonly runId: string;
  readonly idempotencyKey: string | null;
}

export interface GatewayHttpRequestBody {
  readonly args: unknown;
  readonly context: GatewayInvokeContext;
}

export type GatewayHttpResponseBody =
  | { readonly result: unknown }
  | { readonly error: string; readonly detail?: unknown };

export interface ApiGatewayDispatchInput extends ApiInvokeRequest {
  readonly gameId: string;
  readonly triggeringSessionId: string | null;
  readonly triggeringJwtClaims: Readonly<Record<string, unknown>> | null;
  readonly connectedSessions: readonly ConnectedSessionSnapshot[];
  readonly bundleName: string;
  readonly bundleCompatTag: string;
  readonly runId: string;
  readonly replayMode?: boolean;
}

export interface ApiInvokeWireRecord {
  readonly event: "api.invoke";
  readonly requestId: string;
  readonly fingerprint: string;
  readonly mode: "live" | "replay";
  readonly kind: string;
  readonly gameId: string;
  readonly runId: string;
  readonly rawOutbound: string;
  readonly rawInbound: string;
  readonly statusCode: number;
  readonly error?: ApiInvokeError;
  readonly recordedAt: string;
}

export interface ApiInvokeIpcPayload extends ApiInvokeRequest {
  readonly triggeringSessionId: string | null;
}

export interface ApiInvokeIpcResponsePayload {
  readonly response: ApiInvokeResponse;
}

// ----- Discriminated union: parent → child --------------------------------

export type ParentToChildEnvelope =
  | IpcEnvelope<"bootstrap", BootstrapPayload>
  | IpcEnvelope<"api.invoke.response", ApiInvokeIpcResponsePayload>
  | IpcEnvelope<"onWake", OnWakePayload>
  | IpcEnvelope<"onSleep", OnSleepPayload>
  | IpcEnvelope<"onPlayerConnect", OnPlayerConnectPayload>
  | IpcEnvelope<"onPlayerDisconnect", OnPlayerDisconnectPayload>
  | IpcEnvelope<"onPlayerMessage", OnPlayerMessagePayload>
  | IpcEnvelope<"onCapacityWarning", OnCapacityWarningPayload>;

export interface BootstrapPayload {
  readonly bundleName: string;
  readonly bundleSource: string;
  readonly bundleCompatTag: string;
  readonly runId: string;
  readonly gameId: string;
  readonly memoryLimitMb: number;
}

// ----- Child → parent envelopes -----------------------------------------

export type WsTarget = string | readonly string[] | "all";

export interface WsSendPayload {
  readonly target: WsTarget;
  readonly body: unknown;
}

export interface LogEmitPayload {
  readonly event?: string;
  readonly [key: string]: unknown;
}

export interface ChildFatalPayload {
  readonly message: string;
  readonly error: string;
}

export interface ChildHandlerErrorPayload {
  readonly handler: string;
  readonly error: string;
}

export interface ChildUnknownMessagePayload {
  readonly type: string;
}

export type ChildToParentEnvelope =
  | IpcEnvelope<"ready", { bundleName: string; bundleCompatTag: string; runId: string; gameId: string }>
  | IpcEnvelope<"api.invoke", ApiInvokeIpcPayload>
  | IpcEnvelope<"ws.send", WsSendPayload>
  | IpcEnvelope<"log.emit", LogEmitPayload>
  | IpcEnvelope<"lifecycle.requestSleep", Record<string, never>>
  | IpcEnvelope<"child.fatal", ChildFatalPayload>
  | IpcEnvelope<"child.handlerError", ChildHandlerErrorPayload>
  | IpcEnvelope<"child.unknownMessage", ChildUnknownMessagePayload>;

// Channel-name catalogs for places where a string is fine (e.g. logs).
export const PARENT_TO_CHILD = Object.freeze({
  bootstrap: "bootstrap",
  apiInvokeResponse: "api.invoke.response",
  onWake: "onWake",
  onSleep: "onSleep",
  onPlayerConnect: "onPlayerConnect",
  onPlayerDisconnect: "onPlayerDisconnect",
  onPlayerMessage: "onPlayerMessage",
  onCapacityWarning: "onCapacityWarning",
} as const);

export const CHILD_TO_PARENT = Object.freeze({
  ready: "ready",
  apiInvoke: "api.invoke",
  wsSend: "ws.send",
  logEmit: "log.emit",
  lifecycleRequestSleep: "lifecycle.requestSleep",
} as const);

// ----- Redis row schemas (must match what parent-actor writes) -----------

export interface ShardRivetInfo {
  readonly namespace: string;
  readonly runnerName: string;
  readonly actorName: string;
  /** Env var name on the consumer side that holds the engine admin token. */
  readonly adminTokenHint: string;
}

export interface ShardRegistration {
  readonly shardId: string;
  readonly url: string;
  readonly healthy: boolean;
  readonly acceptingWakes: boolean;
  readonly runtimeContractsSupported: readonly [number, number];
  readonly activeGames: number;
  readonly cpuPct: number;
  readonly recentWakeRate: number;
  readonly lastSeenAt: number;
  readonly rivet: ShardRivetInfo;
}

export interface ActiveGamePlacement {
  readonly gameId: string;
  readonly shardId: string;
  readonly actorId: string;
  readonly placedAt: number;
  readonly refreshedAt: number;
  readonly generation: number;
}

export interface BundleManifest {
  readonly compatTagProduced: string;
  readonly compatTagsAccepted: readonly string[];
  readonly runtimeContractRequired: number;
}

export interface BundleRecord {
  readonly bundleName: string;
  readonly manifest: BundleManifest;
  readonly publishedAt: number;
}

export interface GameRecord {
  readonly gameId: string;
  readonly bundleName: string;
  readonly blobCompatTag?: string;
  readonly createdAt: number;
}

// ----- ID generators ------------------------------------------------------

/**
 * Substrate-generated sessionId: opaque, unforgeable, cluster-unique.
 * Production should switch to UUIDv7 for sort order; smoke uses 128 random
 * bits. The "ses_" prefix is part of the surface contract.
 */
export function generateSessionId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return (
    "ses_" +
    Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

export function generateRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)
    .toString(36)
    .padStart(4, "0")}`;
}
