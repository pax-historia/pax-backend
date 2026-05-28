// runtime/child-runner-noivm — conformance runner without isolated-vm.
//
// This runner deliberately shares the child-process boundary and IPC schema
// with child-runner-ivm, but evaluates the creator bundle directly in Node.
// It is weaker sandboxing and exists to catch IPC/runtime drift.

import { randomUUID } from "node:crypto";

import {
  type ApiInvokeResponse,
  type BootstrapPayload,
  CHILD_TO_PARENT,
  type ChildToParentEnvelope,
  type ComputeBudgetSnapshot,
  type ConnectedSessionSnapshot,
  type OnPlayerMessagePayload,
  PARENT_TO_CHILD,
  type ParentToChildEnvelope,
  type StorageReadResponsePayload,
  type StorageWriteResponse,
  type WsSendResponse,
  envelope,
} from "@pax-backend/ipc-protocol";
import type { BundleDefinition, SubstrateContext } from "@pax-backend/runtime-sdk";

const PER_HANDLER_TIMEOUT_MS = 1_000;
const PARENT_REQUEST_TIMEOUT_MS = 30_000;

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

interface PendingParentRequest {
  readonly resolve: (value: unknown) => void;
  readonly timeout: NodeJS.Timeout;
}

interface PaxGlobal {
  __pax_install?: (bundle: BundleDefinition) => void;
  __pax_bundle?: BundleDefinition | null;
  c?: SubstrateContext;
}

const pendingParentRequests = new Map<string, PendingParentRequest>();
let bundleExports: BundleDefinition | undefined;
let currentTriggeringSessionId: string | null = null;
let nextRandom = makeMulberry32(1);
let nextNow = 1_700_000_000_000;

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

async function bootstrap(cfg: BootstrapPayload): Promise<void> {
  const seed = hashSeed(`${cfg.gameId}:${cfg.bundleName}:${cfg.bundleCompatTag}`);
  nextRandom = makeMulberry32(seed);
  nextNow = 1_700_000_000_000 + (seed % 1_000_000_000);
  const g = globalThis as PaxGlobal;
  g.__pax_bundle = null;
  g.__pax_install = (bundle) => {
    g.__pax_bundle = bundle;
  };
  g.c = makeContext();

  try {
    const runBundle = new Function(cfg.bundleSource) as () => void;
    runBundle();
  } catch (err) {
    panic("bundle eval failed", err);
    return;
  }

  if (!g.__pax_bundle) {
    panic("bundle did not call __pax_install", new Error("no __pax_bundle"));
    return;
  }
  bundleExports = g.__pax_bundle;
  emitOne(CHILD_TO_PARENT.ready, {
    bundleName: cfg.bundleName,
    bundleCompatTag: cfg.bundleCompatTag,
    runId: cfg.runId,
    gameId: cfg.gameId,
  });
}

function makeContext(): SubstrateContext {
  return {
    rng: () => nextRandom(),
    now: () => {
      nextNow += 1;
      return nextNow;
    },
    ws: {
      send: async (target, body) =>
        (await invokeParent(CHILD_TO_PARENT.wsSend, {
          target: jsonClone(target),
          body: jsonClone(body),
        })) as WsSendResponse,
    },
    log: {
      emit: (payload) => emitOne(CHILD_TO_PARENT.logEmit, jsonClone(payload)),
    },
    metrics: {
      emit: (payload) => emitOne(CHILD_TO_PARENT.metricsEmit, jsonClone(payload)),
    },
    lifecycle: {
      requestSleep: () => emitOne(CHILD_TO_PARENT.lifecycleRequestSleep, {}),
    },
    api: {
      invoke: async (kind, args, options = {}) =>
        (await invokeParent(CHILD_TO_PARENT.apiInvoke, {
          kind,
          args: jsonClone(args),
          idempotencyKey: options.idempotencyKey,
          triggeringSessionId: currentTriggeringSessionId,
        })) as ApiInvokeResponse,
    },
    players: {
      allowed: async () =>
        (await invokeParent(
          CHILD_TO_PARENT.playersAllowed,
          {},
        )) as readonly string[],
      connected: async () =>
        (await invokeParent(
          CHILD_TO_PARENT.playersConnected,
          {},
        )) as readonly ConnectedSessionSnapshot[],
    },
    compute: {
      budget: async () =>
        (await invokeParent(
          CHILD_TO_PARENT.computeBudget,
          {},
        )) as ComputeBudgetSnapshot,
    },
    state: {
      read: async () => readStorage(CHILD_TO_PARENT.stateRead),
      write: async (value) => writeStorage(CHILD_TO_PARENT.stateWrite, value),
      flush: async () =>
        (await invokeParent(
          CHILD_TO_PARENT.stateFlush,
          {},
        )) as StorageWriteResponse,
    },
    blob: {
      read: async () => readStorage(CHILD_TO_PARENT.blobRead),
      write: async (value) => writeStorage(CHILD_TO_PARENT.blobWrite, value),
    },
  };
}

async function readStorage(type: "state.read" | "blob.read"): Promise<unknown | undefined> {
  const response = (await invokeParent(type, {})) as StorageReadResponsePayload;
  return response.found ? response.value : undefined;
}

async function writeStorage(
  type: "state.write" | "blob.write",
  value: unknown,
): Promise<StorageWriteResponse> {
  try {
    return (await invokeParent(type, { value: jsonClone(value) })) as StorageWriteResponse;
  } catch (err) {
    return {
      ok: false,
      error: "storageUnavailable",
      detail: { message: err instanceof Error ? err.message : String(err) },
    };
  }
}

function invokeParent(type: ParentRequestType, payload: Record<string, unknown>): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
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

function completeParentRequest(requestId: string | undefined, value: unknown): void {
  if (!requestId) return;
  const pending = pendingParentRequests.get(requestId);
  if (!pending) return;
  pendingParentRequests.delete(requestId);
  clearTimeout(pending.timeout);
  pending.resolve(value);
}

type HandlerName =
  | "onWake"
  | "onSleep"
  | "onPlayerConnect"
  | "onPlayerDisconnect"
  | "onPlayerMessage"
  | "onCapacityWarning";

async function invokeHandler(handlerName: HandlerName, payload: unknown): Promise<boolean> {
  const handler = bundleExports?.[handlerName];
  if (!handler) return true;
  const previousTriggeringSessionId = currentTriggeringSessionId;
  currentTriggeringSessionId = triggeringSessionIdFor(handlerName, payload);
  try {
    await withTimeout(
      Promise.resolve().then(() =>
        handler((globalThis as PaxGlobal).c as SubstrateContext, payload as never),
      ),
      PER_HANDLER_TIMEOUT_MS,
      handlerName,
    );
    return true;
  } catch (err) {
    const errStr =
      err instanceof Error ? err.stack ?? err.message : JSON.stringify(err);
    emitOne("child.handlerError", { handler: handlerName, error: errStr });
    return false;
  } finally {
    currentTriggeringSessionId = previousTriggeringSessionId;
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  handlerName: HandlerName,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${handlerName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timeout.unref();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}

process.on("message", async (raw: unknown) => {
  if (!isParentEnvelope(raw)) {
    emitOne("child.unknownMessage", { type: typeof raw });
    return;
  }
  try {
    switch (raw.type) {
      case PARENT_TO_CHILD.bootstrap:
        await bootstrap(raw.payload);
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
        const _exhaustive: never = raw;
        void _exhaustive;
      }
    }
  } catch (err) {
    panic("parent message handling failed", err);
  }
});

function isParentEnvelope(raw: unknown): raw is ParentToChildEnvelope {
  return (
    !!raw &&
    typeof raw === "object" &&
    "version" in raw &&
    "type" in raw &&
    "payload" in raw
  );
}

function triggeringSessionIdFor(
  handlerName: HandlerName,
  payload: unknown,
): string | null {
  if (handlerName !== "onPlayerMessage") return null;
  const candidate = payload as Partial<OnPlayerMessagePayload>;
  return typeof candidate.sessionId === "string" ? candidate.sessionId : null;
}

function jsonClone<T>(value: T): T {
  const raw = JSON.stringify(value);
  if (typeof raw !== "string") {
    throw new Error("value must be JSON-serializable");
  }
  return JSON.parse(raw) as T;
}

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
