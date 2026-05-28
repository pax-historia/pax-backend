// runtime/child-runner-ivm — the untrusted-JS runner.
//
// One node child_process per game. The bundle source is loaded into an
// isolated-vm Isolate; substrate context (c.ws.send / c.log.emit /
// c.metrics.emit / c.lifecycle.requestSleep / c.api.invoke / c.players.* /
// c.compute.budget / c.state.* / c.blob.* / c.rng / c.now) is exposed as ivm
// bridges or deterministic in-child helpers.
//
// Trust model (README §"Trust model"):
//  - No outbound network (parent forks us with a stripped env).
//  - No environment variables visible (parent passes only PATH + role).
//  - CPU/memory capped by ivm.Isolate({ memoryLimit }) + per-handler timeout.
//
// The child is unaware of WebSockets, Rivet, Fly, or anything outside its
// IPC. Everything it knows about the world arrives as a ParentToChildEnvelope.

import { randomUUID } from "node:crypto";

import ivm from "isolated-vm";

import {
  type BootstrapPayload,
  CHILD_TO_PARENT,
  type ChildToParentEnvelope,
  type IpcEnvelope,
  type OnPlayerMessagePayload,
  PARENT_TO_CHILD,
  type ParentToChildEnvelope,
  envelope,
} from "@pax-backend/ipc-protocol";

const DEFAULT_HANDLER_TIMEOUT_MS = 1_000;
const PARENT_REQUEST_TIMEOUT_MS = 30_000;

// --- IPC helpers ---------------------------------------------------------

function emit<E extends ChildToParentEnvelope>(env: E): void {
  process.send?.(env);
}

function emitOne<T extends ChildToParentEnvelope["type"]>(
  type: T,
  payload: Extract<ChildToParentEnvelope, { type: T }>["payload"],
): void {
  emit(envelope(type, payload) as ChildToParentEnvelope);
}

function panic(message: string, error: unknown): void {
  const errStr =
    error instanceof Error
      ? error.stack ?? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  emitOne("child.fatal", { message, error: errStr });
  setTimeout(() => process.exit(1), 50);
}

process.on("uncaughtException", (err) => panic("uncaughtException", err));
process.on("unhandledRejection", (err) => panic("unhandledRejection", err));

// --- Isolate state -------------------------------------------------------

let isolate: ivm.Isolate | undefined;
let context: ivm.Context | undefined;
let bundleExports: ivm.Reference | undefined;
let currentTriggeringSessionId: string | null = null;
let handlerTimeoutMs = DEFAULT_HANDLER_TIMEOUT_MS;

interface PendingParentRequest {
  readonly resolve: (responseJson: string) => void;
  readonly timeout: NodeJS.Timeout;
}

const pendingParentRequests = new Map<string, PendingParentRequest>();

type ParentRequestType =
  | "api.invoke"
  | "players.allowed"
  | "players.connected"
  | "compute.budget"
  | "state.read"
  | "state.write"
  | "state.flush"
  | "blob.read"
  | "blob.write"
  | "ws.send";

function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
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

async function bootstrapIsolate(cfg: BootstrapPayload): Promise<void> {
  handlerTimeoutMs = validTimeoutMs(cfg.handlerTimeoutMs);
  isolate = new ivm.Isolate({ memoryLimit: cfg.memoryLimitMb });
  context = await isolate.createContext();
  const jail = context.global;
  const seed = hashSeed(`${cfg.gameId}:${cfg.bundleName}:${cfg.bundleCompatTag}`);
  const nextRandom = makeMulberry32(seed);
  let nextNow = 1_700_000_000_000 + (seed % 1_000_000_000);

  // ivm contexts have no globalThis self-reference; bundles often expect one.
  await jail.set("global", jail.derefInto());

  // Expose the substrate context `c` as ivm bridges. Each method posts an
  // IPC envelope back; the parent dispatches.
  const cWsSend = new ivm.Reference((targetJson: string, bodyJson: string) => {
    try {
      const target = JSON.parse(targetJson);
      const body = JSON.parse(bodyJson);
      return invokeParentFromBridge(CHILD_TO_PARENT.wsSend, { target, body });
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
  const cLogEmit = new ivm.Reference((payloadJson: string) => {
    try {
      const payload = JSON.parse(payloadJson) as Record<string, unknown>;
      emitOne(CHILD_TO_PARENT.logEmit, payload);
    } catch (err) {
      panic("c.log.emit bridge failed", err);
    }
  });
  const cMetricsEmit = new ivm.Reference((payloadJson: string) => {
    try {
      const payload = JSON.parse(payloadJson);
      emitOne(CHILD_TO_PARENT.metricsEmit, payload);
    } catch (err) {
      panic("c.metrics.emit bridge failed", err);
    }
  });
  const cLifecycleRequestSleep = new ivm.Reference(() => {
    emitOne(CHILD_TO_PARENT.lifecycleRequestSleep, {});
  });
  const cApiInvoke = new ivm.Reference(
    (kind: string, argsJson: string, idempotencyKey: string | null) =>
      invokeApiFromBridge(kind, argsJson, idempotencyKey),
  );
  const cPlayersAllowed = new ivm.Reference(() =>
    invokeParentFromBridge(CHILD_TO_PARENT.playersAllowed, {}),
  );
  const cPlayersConnected = new ivm.Reference(() =>
    invokeParentFromBridge(CHILD_TO_PARENT.playersConnected, {}),
  );
  const cComputeBudget = new ivm.Reference(() =>
    invokeParentFromBridge(CHILD_TO_PARENT.computeBudget, {}),
  );
  const cRng = new ivm.Reference(() => nextRandom());
  const cNow = new ivm.Reference(() => {
    nextNow += 1;
    return nextNow;
  });
  const cStateRead = new ivm.Reference(() =>
    invokeParentFromBridge(CHILD_TO_PARENT.stateRead, {}),
  );
  const cStateWrite = new ivm.Reference((valueJson: string) =>
    invokeStorageWriteFromBridge(CHILD_TO_PARENT.stateWrite, valueJson),
  );
  const cStateFlush = new ivm.Reference(() =>
    invokeParentFromBridge(CHILD_TO_PARENT.stateFlush, {}),
  );
  const cBlobRead = new ivm.Reference(() =>
    invokeParentFromBridge(CHILD_TO_PARENT.blobRead, {}),
  );
  const cBlobWrite = new ivm.Reference((valueJson: string) =>
    invokeStorageWriteFromBridge(CHILD_TO_PARENT.blobWrite, valueJson),
  );

  await jail.set("__pax_c_ws_send", cWsSend);
  await jail.set("__pax_c_log_emit", cLogEmit);
  await jail.set("__pax_c_metrics_emit", cMetricsEmit);
  await jail.set("__pax_c_lifecycle_requestSleep", cLifecycleRequestSleep);
  await jail.set("__pax_c_api_invoke", cApiInvoke);
  await jail.set("__pax_c_players_allowed", cPlayersAllowed);
  await jail.set("__pax_c_players_connected", cPlayersConnected);
  await jail.set("__pax_c_compute_budget", cComputeBudget);
  await jail.set("__pax_c_rng", cRng);
  await jail.set("__pax_c_now", cNow);
  await jail.set("__pax_c_state_read", cStateRead);
  await jail.set("__pax_c_state_write", cStateWrite);
  await jail.set("__pax_c_state_flush", cStateFlush);
  await jail.set("__pax_c_blob_read", cBlobRead);
  await jail.set("__pax_c_blob_write", cBlobWrite);

  // SDK-equivalent in the isolate. Bundles compiled via esbuild see
  // defineBundle bundled in directly; __pax_install is the only global the
  // ivm runtime injects to receive the compiled bundle's default export.
  await context.eval(
    `
    globalThis.__pax_bundle = null;
    globalThis.__pax_install = (bundle) => { globalThis.__pax_bundle = bundle; };
    const __pax_encode_storage_write = (value) => {
      try {
        const valueJson = JSON.stringify(value);
        if (typeof valueJson !== "string") {
          return {
            ok: false,
            error: "storageUnavailable",
            detail: { message: "storage values must be JSON-serializable" },
          };
        }
        return { ok: true, valueJson };
      } catch (err) {
        return {
          ok: false,
          error: "storageUnavailable",
          detail: {
            message: err && typeof err.message === "string" ? err.message : String(err),
          },
        };
      }
    };
    globalThis.c = {
      rng: () => __pax_c_rng.applySync(undefined, []),
      now: () => __pax_c_now.applySync(undefined, []),
      ws: {
        send: (target, body) => {
          const responseJson = __pax_c_ws_send.applySyncPromise(undefined, [
            JSON.stringify(target),
            JSON.stringify(body),
          ]);
          return Promise.resolve(JSON.parse(responseJson));
        },
      },
      log: {
        emit: (payload) => __pax_c_log_emit.applySync(undefined, [JSON.stringify(payload)]),
      },
      metrics: {
        emit: (payload) => __pax_c_metrics_emit.applySync(undefined, [JSON.stringify(payload)]),
      },
      lifecycle: {
        requestSleep: () => __pax_c_lifecycle_requestSleep.applySync(undefined, []),
      },
      api: {
        invoke: (kind, args, options = {}) => {
          const idempotencyKey =
            options && typeof options.idempotencyKey === "string"
              ? options.idempotencyKey
              : null;
          const responseJson = __pax_c_api_invoke.applySyncPromise(undefined, [
            String(kind),
            JSON.stringify(args),
            idempotencyKey,
          ]);
          return Promise.resolve(JSON.parse(responseJson));
        },
      },
      players: {
        allowed: () => {
          const responseJson = __pax_c_players_allowed.applySyncPromise(undefined, []);
          return Promise.resolve(JSON.parse(responseJson));
        },
        connected: () => {
          const responseJson = __pax_c_players_connected.applySyncPromise(undefined, []);
          return Promise.resolve(JSON.parse(responseJson));
        },
      },
      compute: {
        budget: () => {
          const responseJson = __pax_c_compute_budget.applySyncPromise(undefined, []);
          return Promise.resolve(JSON.parse(responseJson));
        },
      },
      state: {
        read: () => {
          const responseJson = __pax_c_state_read.applySyncPromise(undefined, []);
          const response = JSON.parse(responseJson);
          return Promise.resolve(response.found ? response.value : undefined);
        },
        write: (value) => {
          const encoded = __pax_encode_storage_write(value);
          if (!encoded.ok) return Promise.resolve(encoded);
          const responseJson = __pax_c_state_write.applySyncPromise(undefined, [encoded.valueJson]);
          return Promise.resolve(JSON.parse(responseJson));
        },
        flush: () => {
          const responseJson = __pax_c_state_flush.applySyncPromise(undefined, []);
          return Promise.resolve(JSON.parse(responseJson));
        },
      },
      blob: {
        read: () => {
          const responseJson = __pax_c_blob_read.applySyncPromise(undefined, []);
          const response = JSON.parse(responseJson);
          return Promise.resolve(response.found ? response.value : undefined);
        },
        write: (value) => {
          const encoded = __pax_encode_storage_write(value);
          if (!encoded.ok) return Promise.resolve(encoded);
          const responseJson = __pax_c_blob_write.applySyncPromise(undefined, [encoded.valueJson]);
          return Promise.resolve(JSON.parse(responseJson));
        },
      },
    };
  `,
  );

  // Compile + run the bundle source. Bundles are pre-compiled by
  // scripts/build/build-bundles.sh (esbuild → IIFE → __pax_install) and shipped to
  // the parent as plain script JS. ivm has no module loader, no async-top-
  // level, no fetch — that constraint is by design.
  try {
    await context.eval(cfg.bundleSource, { timeout: handlerTimeoutMs });
  } catch (err) {
    panic("bundle eval failed", err);
    return;
  }

  bundleExports = (await context.global.get("__pax_bundle", { reference: true })) as
    | ivm.Reference
    | undefined;
  if (!bundleExports) {
    panic("bundle did not call __pax_install", new Error("no __pax_bundle"));
    return;
  }

  emitOne(CHILD_TO_PARENT.ready, {
    bundleName: cfg.bundleName,
    bundleCompatTag: cfg.bundleCompatTag,
    runId: cfg.runId,
    gameId: cfg.gameId,
  });
}

type HandlerName =
  | "onWake"
  | "onSleep"
  | "onPlayerConnect"
  | "onPlayerDisconnect"
  | "onPlayerMessage"
  | "onCapacityWarning";

async function invokeHandler(handlerName: HandlerName, payload: unknown): Promise<boolean> {
  if (!bundleExports || !context) return true;
  const fnRef = (await bundleExports.get(handlerName, { reference: true })) as
    | ivm.Reference
    | undefined;
  if (!fnRef) return true;
  const cRef = (await context.global.get("c", { reference: true })) as ivm.Reference;
  const previousTriggeringSessionId = currentTriggeringSessionId;
  currentTriggeringSessionId = triggeringSessionIdFor(handlerName, payload);
  const startedAt = Date.now();
  try {
    await fnRef.apply(
      undefined,
      [cRef.derefInto(), new ivm.ExternalCopy(payload).copyInto()],
      { timeout: handlerTimeoutMs },
    );
    const durationMs = Date.now() - startedAt;
    if (durationMs > handlerTimeoutMs) {
      emitHandlerError(
        handlerName,
        `${handlerName} exceeded ${handlerTimeoutMs}ms`,
        durationMs,
      );
      return false;
    }
    emitOne("child.handlerComplete", {
      handler: handlerName,
      durationMs,
      timeoutMs: handlerTimeoutMs,
    });
    return true;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const errStr =
      err instanceof Error ? err.stack ?? err.message : JSON.stringify(err) ?? String(err);
    emitHandlerError(handlerName, errStr, durationMs);
    return false;
  } finally {
    currentTriggeringSessionId = previousTriggeringSessionId;
  }
}

function emitHandlerError(
  handlerName: HandlerName,
  error: string,
  durationMs: number,
): void {
  emitOne("child.handlerError", {
    handler: handlerName,
    error,
    code: handlerErrorCode(error, durationMs),
    durationMs,
    timeoutMs: handlerTimeoutMs,
  });
}

function handlerErrorCode(
  error: string,
  durationMs: number,
): "handlerError" | "handlerTimeout" {
  return durationMs >= handlerTimeoutMs || error.toLowerCase().includes("timed out")
    ? "handlerTimeout"
    : "handlerError";
}

function validTimeoutMs(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : DEFAULT_HANDLER_TIMEOUT_MS;
}

function invokeApiFromBridge(
  kind: string,
  argsJson: string,
  idempotencyKey: string | null,
): Promise<string> {
  let args: unknown;
  try {
    args = JSON.parse(argsJson) as unknown;
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  const payload =
    idempotencyKey === null
      ? { kind, args, triggeringSessionId: currentTriggeringSessionId }
      : { kind, args, idempotencyKey, triggeringSessionId: currentTriggeringSessionId };
  return invokeParentFromBridge(CHILD_TO_PARENT.apiInvoke, payload);
}

function invokeParentFromBridge(
  type: ParentRequestType,
  payload: Record<string, unknown>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!process.send) {
      reject(new Error(`${type} unavailable: child IPC is closed`));
      return;
    }
    const requestId = randomUUID();
    const timeout = setTimeout(() => {
      pendingParentRequests.delete(requestId);
      reject(new Error(`${type} timed out after ${PARENT_REQUEST_TIMEOUT_MS}ms`));
    }, PARENT_REQUEST_TIMEOUT_MS);
    timeout.unref();

    pendingParentRequests.set(requestId, { resolve, timeout });
    emit(envelope(type, payload, requestId) as ChildToParentEnvelope);
  });
}

function invokeStorageWriteFromBridge(
  type: "state.write" | "blob.write",
  valueJson: string,
): Promise<string> {
  try {
    return invokeParentFromBridge(type, { value: JSON.parse(valueJson) as unknown });
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

function completeParentRequest(
  requestId: string | undefined,
  value: unknown,
): void {
  if (!requestId) return;
  const pending = pendingParentRequests.get(requestId);
  if (!pending) return;
  pendingParentRequests.delete(requestId);
  clearTimeout(pending.timeout);
  pending.resolve(JSON.stringify(value));
}

function triggeringSessionIdFor(
  handlerName: HandlerName,
  payload: unknown,
): string | null {
  if (handlerName !== "onPlayerMessage") return null;
  const candidate = payload as Partial<OnPlayerMessagePayload>;
  return typeof candidate.sessionId === "string" ? candidate.sessionId : null;
}

// --- IPC dispatcher -----------------------------------------------------

function isParentEnvelope(raw: unknown): raw is ParentToChildEnvelope {
  return (
    !!raw &&
    typeof raw === "object" &&
    "version" in raw &&
    "type" in raw &&
    "payload" in raw
  );
}

process.on("message", async (raw: unknown) => {
  if (!isParentEnvelope(raw)) {
    emitOne("child.unknownMessage", { type: String((raw as { type?: unknown })?.type ?? "?") });
    return;
  }
  try {
    switch (raw.type) {
      case PARENT_TO_CHILD.bootstrap:
        await bootstrapIsolate((raw as IpcEnvelope<"bootstrap", BootstrapPayload>).payload);
        return;
      case PARENT_TO_CHILD.apiInvokeResponse:
        completeParentRequest(raw.requestId, raw.payload.response);
        return;
      case PARENT_TO_CHILD.playersAllowedResponse:
        completeParentRequest(raw.requestId, raw.payload.players);
        return;
      case PARENT_TO_CHILD.playersConnectedResponse:
        completeParentRequest(raw.requestId, raw.payload.players);
        return;
      case PARENT_TO_CHILD.computeBudgetResponse:
        completeParentRequest(raw.requestId, raw.payload.budget);
        return;
      case PARENT_TO_CHILD.stateReadResponse:
        completeParentRequest(raw.requestId, raw.payload);
        return;
      case PARENT_TO_CHILD.stateWriteResponse:
        completeParentRequest(raw.requestId, raw.payload.response);
        return;
      case PARENT_TO_CHILD.stateFlushResponse:
        completeParentRequest(raw.requestId, raw.payload.response);
        return;
      case PARENT_TO_CHILD.blobReadResponse:
        completeParentRequest(raw.requestId, raw.payload);
        return;
      case PARENT_TO_CHILD.blobWriteResponse:
        completeParentRequest(raw.requestId, raw.payload.response);
        return;
      case PARENT_TO_CHILD.wsSendResponse:
        completeParentRequest(raw.requestId, raw.payload.response);
        return;
      case PARENT_TO_CHILD.onWake:
        await invokeHandler("onWake", raw.payload);
        return;
      case PARENT_TO_CHILD.onSleep:
        if (await invokeHandler("onSleep", raw.payload)) {
          emitOne(CHILD_TO_PARENT.lifecycleSleepComplete, {
            reason: raw.payload.reason,
            deadline: raw.payload.deadline,
          });
        }
        return;
      case PARENT_TO_CHILD.onPlayerConnect:
        await invokeHandler("onPlayerConnect", raw.payload);
        return;
      case PARENT_TO_CHILD.onPlayerDisconnect:
        await invokeHandler("onPlayerDisconnect", raw.payload);
        return;
      case PARENT_TO_CHILD.onPlayerMessage:
        await invokeHandler("onPlayerMessage", raw.payload);
        return;
      case PARENT_TO_CHILD.onCapacityWarning:
        await invokeHandler("onCapacityWarning", raw.payload);
        return;
      default: {
        // Exhaustive check — TypeScript will catch a missed type at compile time.
        const _exhaustive: never = raw;
        void _exhaustive;
        emitOne("child.unknownMessage", { type: (raw as { type: string }).type });
      }
    }
  } catch (err) {
    panic(`dispatcher for ${raw.type} failed`, err);
  }
});
