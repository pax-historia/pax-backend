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
export const SHARD_DRAIN_KEY_PREFIX = "shard_drain:" as const;
export const PLACEMENT_RECENT_WAKES_KEY_PREFIX = "placement_recent_wakes:" as const;
export const BUNDLE_KEY_PREFIX = "bundles:" as const;
export const GAME_KEY_PREFIX = "games:" as const;
export const ALLOWED_PLAYERS_KEY_PREFIX = "allowed_players:" as const;
export const API_KIND_KEY_PREFIX = "api_kinds:" as const;
export const STATE_KEY_PREFIX = "state:" as const;
export const BLOB_KEY_PREFIX = "blob:" as const;
export const HOST_EVENT_QUEUE_KEY_PREFIX = "host_events:" as const;

export const SHARD_REGISTRY_TTL_SECONDS = 45 as const;
export const ACTIVE_GAME_TTL_SECONDS = 3600 as const;
export const PLACEMENT_RECENT_WAKES_TTL_SECONDS = 45 as const;
export const DEFAULT_STATE_BYTES_LIMIT = 131072 as const;
export const DEFAULT_BLOB_BYTES_LIMIT = 104857600 as const;
export const DEFAULT_BLOB_KEYS_LIMIT = 1024 as const;
export const HOST_EVENT_QUEUE_TTL_SECONDS = 30 * 24 * 60 * 60;

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
  | "cold-restart-from-storage"
  | "upgrade";

export type WakeErrorClass = "oom" | "crash" | "cpuTimeout" | "unknown";

export interface OnWakePayload {
  readonly reason: WakeReason;
  readonly errorClass?: WakeErrorClass;
  readonly runId: string;
  readonly bundleName: string;
  readonly bundleCompatTag: string;
  readonly blobCompatTag?: string;
  readonly state?: unknown;
}

export interface OnSleepPayload {
  readonly deadline: number;
  readonly reason:
    | "idle"
    | "requestedBySleep"
    | "evicted"
    | "shardEvicted"
    | "shutdown"
    | "upgrade";
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

export interface OnHostEventPayload {
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly receivedAt: number;
  readonly deliveryAttempts: number;
}

export interface HostEventRecord extends OnHostEventPayload {
  readonly gameId: string;
  readonly wakeOnDelivery: boolean;
  readonly expiresAt: number;
}

// ----- External API channel + gateway envelope --------------------------

export const GATEWAY_ENVELOPE_VERSION = 2 as const;

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

export interface ApiKindRegistration {
  readonly kindName: string;
  readonly url: string;
  readonly registeredAt?: number;
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
  readonly traceId: string | null;
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
  readonly traceId: string | null;
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

export interface ApiGatewayInvokeResult {
  readonly response: ApiInvokeResponse;
  readonly wireRecord?: ApiInvokeWireRecord;
}

export interface ApiInvokeIpcPayload extends ApiInvokeRequest {
  readonly triggeringSessionId: string | null;
}

export interface ApiInvokeIpcResponsePayload {
  readonly response: ApiInvokeResponse;
}

export interface PlayersAllowedIpcResponsePayload {
  readonly players: readonly string[];
}

export interface PlayersConnectedIpcResponsePayload {
  readonly players: readonly ConnectedSessionSnapshot[];
}

export type ComputeBudgetName =
  | "cpu-ms-per-tick"
  | "memory-bytes"
  | "bandwidth-bytes-per-sec"
  | "ws-messages-per-sec"
  | "state-bytes"
  | "blob-bytes"
  | "blob-keys"
  | "api-invocations-per-min";

export interface ComputeBudgetUsage {
  readonly currentUsage: number;
  readonly limit: number;
  readonly windowMs?: number;
}

export type ComputeBudgetSnapshot = Readonly<
  Record<ComputeBudgetName, ComputeBudgetUsage>
>;

export interface ComputeBudgetIpcResponsePayload {
  readonly budget: ComputeBudgetSnapshot;
}

export type StorageWriteResponse =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: "sizeExceeded" | "keyCountExceeded" | "storageUnavailable";
      readonly detail?: unknown;
    };

export interface StorageReadResponsePayload {
  readonly found: boolean;
  readonly value?: unknown;
  readonly bytes: number;
}

export interface StorageWriteIpcPayload {
  readonly value: unknown;
}

export interface StorageWriteResponsePayload {
  readonly response: StorageWriteResponse;
}

export interface StorageFlushResponsePayload {
  readonly response: StorageWriteResponse;
}

export interface BlobPutIpcPayload {
  readonly key: string;
  readonly bytesBase64: string;
}

export interface BlobGetIpcPayload {
  readonly key: string;
}

export interface BlobGetResponsePayload {
  readonly found: boolean;
  readonly bytesBase64?: string;
  readonly bytes: number;
}

export interface BlobDeleteIpcPayload {
  readonly key: string;
}

export interface BlobDeleteResponsePayload {
  readonly ok: true;
}

export interface BlobListIpcPayload {
  readonly prefix?: string;
}

export interface BlobListItem {
  readonly key: string;
  readonly size: number;
}

export interface BlobListResponsePayload {
  readonly items: readonly BlobListItem[];
}

// ----- Discriminated union: parent → child --------------------------------

export type ParentToChildEnvelope =
  | IpcEnvelope<"bootstrap", BootstrapPayload>
  | IpcEnvelope<"api.invoke.response", ApiInvokeIpcResponsePayload>
  | IpcEnvelope<"players.allowed.response", PlayersAllowedIpcResponsePayload>
  | IpcEnvelope<"players.connected.response", PlayersConnectedIpcResponsePayload>
  | IpcEnvelope<"compute.budget.response", ComputeBudgetIpcResponsePayload>
  | IpcEnvelope<"state.read.response", StorageReadResponsePayload>
  | IpcEnvelope<"state.write.response", StorageWriteResponsePayload>
  | IpcEnvelope<"state.flush.response", StorageFlushResponsePayload>
  | IpcEnvelope<"blob.put.response", StorageWriteResponsePayload>
  | IpcEnvelope<"blob.get.response", BlobGetResponsePayload>
  | IpcEnvelope<"blob.delete.response", BlobDeleteResponsePayload>
  | IpcEnvelope<"blob.list.response", BlobListResponsePayload>
  | IpcEnvelope<"ws.send.response", WsSendResponsePayload>
  | IpcEnvelope<"onWake", OnWakePayload>
  | IpcEnvelope<"onSleep", OnSleepPayload>
  | IpcEnvelope<"onPlayerConnect", OnPlayerConnectPayload>
  | IpcEnvelope<"onPlayerDisconnect", OnPlayerDisconnectPayload>
  | IpcEnvelope<"onPlayerMessage", OnPlayerMessagePayload>
  | IpcEnvelope<"onCapacityWarning", OnCapacityWarningPayload>
  | IpcEnvelope<"onHostEvent", OnHostEventPayload>;

export interface BootstrapPayload {
  readonly bundleName: string;
  readonly bundleSource: string;
  readonly bundleCompatTag: string;
  readonly runId: string;
  readonly gameId: string;
  readonly memoryLimitMb: number;
  readonly handlerTimeoutMs: number;
  readonly testSeed?: string;
}

// ----- Child → parent envelopes -----------------------------------------

export type WsTarget = string | readonly string[] | "all";

export interface WsSendPayload {
  readonly target: WsTarget;
  readonly body: unknown;
}

export type WsSendError =
  | "bandwidthExceeded"
  | "rateExceeded"
  | "serializationFailed"
  | "targetInvalid"
  | "targetNotConnected";

export type WsSendResponse =
  | {
      readonly ok: true;
      readonly sent: number;
      readonly bytes: number;
    }
  | {
      readonly ok: false;
      readonly error: WsSendError;
      readonly detail?: unknown;
    };

export interface WsSendRejectedPayload {
  readonly error: WsSendError;
  readonly detail?: unknown;
}

export interface WsSendResponsePayload {
  readonly response: WsSendResponse;
}

export interface LogEmitPayload {
  readonly event?: string;
  readonly [key: string]: unknown;
}

export type MetricKind = "counter" | "gauge" | "histogram";

export interface MetricsEmitPayload {
  readonly name: string;
  readonly kind: MetricKind;
  readonly value: number;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface ChildFatalPayload {
  readonly message: string;
  readonly error: string;
}

export interface ChildHandlerErrorPayload {
  readonly handler: string;
  readonly error: string;
  readonly code: "handlerError" | "handlerTimeout";
  readonly durationMs: number;
  readonly timeoutMs: number;
}

export interface ChildHandlerCompletePayload {
  readonly handler: string;
  readonly durationMs: number;
  readonly timeoutMs: number;
}

export interface ChildUnknownMessagePayload {
  readonly type: string;
}

export interface LifecycleSleepCompletePayload {
  readonly reason: OnSleepPayload["reason"];
  readonly deadline: number;
}

export type ChildToParentEnvelope =
  | IpcEnvelope<"ready", { bundleName: string; bundleCompatTag: string; runId: string; gameId: string }>
  | IpcEnvelope<"api.invoke", ApiInvokeIpcPayload>
  | IpcEnvelope<"players.allowed", Record<string, never>>
  | IpcEnvelope<"players.connected", Record<string, never>>
  | IpcEnvelope<"compute.budget", Record<string, never>>
  | IpcEnvelope<"state.read", Record<string, never>>
  | IpcEnvelope<"state.write", StorageWriteIpcPayload>
  | IpcEnvelope<"state.flush", Record<string, never>>
  | IpcEnvelope<"blob.put", BlobPutIpcPayload>
  | IpcEnvelope<"blob.get", BlobGetIpcPayload>
  | IpcEnvelope<"blob.delete", BlobDeleteIpcPayload>
  | IpcEnvelope<"blob.list", BlobListIpcPayload>
  | IpcEnvelope<"ws.send", WsSendPayload>
  | IpcEnvelope<"ws.send.rejected", WsSendRejectedPayload>
  | IpcEnvelope<"log.emit", LogEmitPayload>
  | IpcEnvelope<"metrics.emit", MetricsEmitPayload>
  | IpcEnvelope<"lifecycle.requestSleep", Record<string, never>>
  | IpcEnvelope<"lifecycle.sleepComplete", LifecycleSleepCompletePayload>
  | IpcEnvelope<"child.fatal", ChildFatalPayload>
  | IpcEnvelope<"child.handlerError", ChildHandlerErrorPayload>
  | IpcEnvelope<"child.handlerComplete", ChildHandlerCompletePayload>
  | IpcEnvelope<"child.unknownMessage", ChildUnknownMessagePayload>;

// Channel-name catalogs for places where a string is fine (e.g. logs).
export const PARENT_TO_CHILD = Object.freeze({
  bootstrap: "bootstrap",
  apiInvokeResponse: "api.invoke.response",
  playersAllowedResponse: "players.allowed.response",
  playersConnectedResponse: "players.connected.response",
  computeBudgetResponse: "compute.budget.response",
  stateReadResponse: "state.read.response",
  stateWriteResponse: "state.write.response",
  stateFlushResponse: "state.flush.response",
  blobPutResponse: "blob.put.response",
  blobGetResponse: "blob.get.response",
  blobDeleteResponse: "blob.delete.response",
  blobListResponse: "blob.list.response",
  wsSendResponse: "ws.send.response",
  onWake: "onWake",
  onSleep: "onSleep",
  onPlayerConnect: "onPlayerConnect",
  onPlayerDisconnect: "onPlayerDisconnect",
  onPlayerMessage: "onPlayerMessage",
  onCapacityWarning: "onCapacityWarning",
  onHostEvent: "onHostEvent",
} as const);

export const CHILD_TO_PARENT = Object.freeze({
  ready: "ready",
  apiInvoke: "api.invoke",
  playersAllowed: "players.allowed",
  playersConnected: "players.connected",
  computeBudget: "compute.budget",
  stateRead: "state.read",
  stateWrite: "state.write",
  stateFlush: "state.flush",
  blobPut: "blob.put",
  blobGet: "blob.get",
  blobDelete: "blob.delete",
  blobList: "blob.list",
  wsSend: "ws.send",
  wsSendRejected: "ws.send.rejected",
  logEmit: "log.emit",
  metricsEmit: "metrics.emit",
  lifecycleRequestSleep: "lifecycle.requestSleep",
  lifecycleSleepComplete: "lifecycle.sleepComplete",
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
  readonly status: "healthy" | "draining" | "drained" | "unhealthy";
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
  readonly uploadedAt?: string;
  readonly uploadedBy?: string;
  readonly tigrisPath?: string;
  readonly sourceObjectKey?: string;
  readonly manifestObjectKey?: string;
  readonly metadataObjectKey?: string;
  readonly contentSha256?: string;
  readonly sizeBytes?: number;
  /** Legacy local smoke path; new control-plane uploads store source in Tigris. */
  readonly source?: string;
  readonly publishedAt?: number;
}

export interface GameRecord {
  readonly gameId: string;
  readonly bundleName: string;
  readonly blobCompatTag?: string;
  readonly bundleRollback?: BundleRollbackRecord;
  readonly createdAt: number;
}

export interface BundleRollbackRecord {
  readonly previousBundleName: string;
  readonly failedBundleName: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly consecutiveWakeFailures: number;
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

export interface IdGenerator {
  generateSessionId(): string;
  generateRunId(): string;
}

export function createDefaultIdGenerator(): IdGenerator {
  return {
    generateSessionId,
    generateRunId,
  };
}

export function createDeterministicIdGenerator(seedText: string): IdGenerator {
  const nextRandom = makeMulberry32(hashSeed(seedText));
  const seedSlug = slugSeed(seedText);
  let runCounter = 0;
  return {
    generateSessionId: () => `ses_${deterministicHex(nextRandom, 16)}`,
    generateRunId: () => {
      runCounter += 1;
      return `run_${seedSlug}_${runCounter.toString(36).padStart(4, "0")}`;
    },
  };
}

function deterministicHex(nextRandom: () => number, byteCount: number): string {
  let out = "";
  for (let index = 0; index < byteCount; index += 1) {
    out += Math.floor(nextRandom() * 256)
      .toString(16)
      .padStart(2, "0");
  }
  return out;
}

function slugSeed(seedText: string): string {
  const slug = seedText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug.length > 0 ? slug : hashSeed(seedText).toString(36);
}

function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function makeMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}
