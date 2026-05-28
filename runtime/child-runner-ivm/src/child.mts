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
  | "blob.put"
  | "blob.get"
  | "blob.delete"
  | "blob.list"
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
  const seed = hashSeed(
    `${cfg.testSeed ?? "runtime"}:${cfg.gameId}:${cfg.bundleName}:${cfg.bundleCompatTag}`,
  );
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
  const cWsSendRejected = new ivm.Reference((payloadJson: string) => {
    try {
      const payload = JSON.parse(payloadJson);
      emitOne(CHILD_TO_PARENT.wsSendRejected, payload);
    } catch (err) {
      panic("ws.send.rejected bridge failed", err);
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
  const cBlobPut = new ivm.Reference((key: string, bytesBase64: string) =>
    invokeParentFromBridge(CHILD_TO_PARENT.blobPut, { key, bytesBase64 }),
  );
  const cBlobGet = new ivm.Reference((key: string) =>
    invokeParentFromBridge(CHILD_TO_PARENT.blobGet, { key }),
  );
  const cBlobDelete = new ivm.Reference((key: string) =>
    invokeParentFromBridge(CHILD_TO_PARENT.blobDelete, { key }),
  );
  const cBlobList = new ivm.Reference((prefix: string | null) =>
    invokeParentFromBridge(
      CHILD_TO_PARENT.blobList,
      prefix === null ? {} : { prefix },
    ),
  );

  await jail.set("__pax_c_ws_send", cWsSend);
  await jail.set("__pax_c_ws_send_rejected", cWsSendRejected);
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
  await jail.set("__pax_c_blob_put", cBlobPut);
  await jail.set("__pax_c_blob_get", cBlobGet);
  await jail.set("__pax_c_blob_delete", cBlobDelete);
  await jail.set("__pax_c_blob_list", cBlobList);

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
    const __pax_base64_chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const __pax_bytes_to_base64 = (bytes) => {
      if (!(bytes instanceof Uint8Array)) {
        throw new Error("c.blob.put bytes must be a Uint8Array");
      }
      let out = "";
      for (let i = 0; i < bytes.length; i += 3) {
        const a = bytes[i];
        const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
        const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
        const triplet = (a << 16) | (b << 8) | c;
        out += __pax_base64_chars[(triplet >> 18) & 63];
        out += __pax_base64_chars[(triplet >> 12) & 63];
        out += i + 1 < bytes.length ? __pax_base64_chars[(triplet >> 6) & 63] : "=";
        out += i + 2 < bytes.length ? __pax_base64_chars[triplet & 63] : "=";
      }
      return out;
    };
    const __pax_base64_to_bytes = (base64) => {
      const clean = String(base64).replace(/=+$/, "");
      const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
      let buffer = 0;
      let bits = 0;
      let index = 0;
      for (const ch of clean) {
        const value = __pax_base64_chars.indexOf(ch);
        if (value < 0) throw new Error("invalid base64 in blob.get response");
        buffer = (buffer << 6) | value;
        bits += 6;
        if (bits >= 8) {
          bits -= 8;
          out[index] = (buffer >> bits) & 255;
          index += 1;
        }
      }
      return index === out.length ? out : out.slice(0, index);
    };
    const __pax_blob_storage_unavailable = (message) => ({
      ok: false,
      error: "storageUnavailable",
      detail: { message },
    });
    const __pax_encode_json_arg = (field, value) => {
      try {
        const valueJson = JSON.stringify(value);
        if (typeof valueJson !== "string") {
          return __pax_ws_send_serialization_failed(
            field,
            "value must be JSON-serializable",
          );
        }
        return { ok: true, valueJson };
      } catch (err) {
        return __pax_ws_send_serialization_failed(
          field,
          err && typeof err.message === "string" ? err.message : String(err),
        );
      }
    };
    const __pax_ws_send_serialization_failed = (field, message) => {
      const response = {
        ok: false,
        error: "serializationFailed",
        detail: { field, message },
      };
      __pax_c_ws_send_rejected.applySync(undefined, [
        JSON.stringify({
          error: response.error,
          detail: response.detail,
        }),
      ]);
      return { ok: false, response };
    };
    const __pax_console_message_part = (value) => {
      if (typeof value === "string") return value;
      if (value instanceof Error) return value.stack || value.message;
      try {
        const json = JSON.stringify(value);
        return typeof json === "string" ? json : String(value);
      } catch {
        return String(value);
      }
    };
    const __pax_console_payload_part = (value) => {
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
      if (typeof value === "symbol") return String(value);
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return String(value);
      }
    };
    const __pax_console_emit = (level, args) => {
      __pax_c_log_emit.applySync(undefined, [
        JSON.stringify({
          event: "console",
          source: "console",
          level,
          message: args.map(__pax_console_message_part).join(" "),
          args: args.map(__pax_console_payload_part),
        }),
      ]);
    };
    globalThis.console = Object.assign(globalThis.console || {}, {
      debug: (...args) => __pax_console_emit("debug", args),
      log: (...args) => __pax_console_emit("log", args),
      info: (...args) => __pax_console_emit("info", args),
      warn: (...args) => __pax_console_emit("warn", args),
      error: (...args) => __pax_console_emit("error", args),
    });
    globalThis.c = {
      rng: () => __pax_c_rng.applySync(undefined, []),
      now: () => __pax_c_now.applySync(undefined, []),
      ws: {
        send: (target, body) => {
          const targetJson = __pax_encode_json_arg("target", target);
          if (!targetJson.ok) return Promise.resolve(targetJson.response);
          const bodyJson = __pax_encode_json_arg("body", body);
          if (!bodyJson.ok) return Promise.resolve(bodyJson.response);
          const responseJson = __pax_c_ws_send.applySyncPromise(undefined, [
            targetJson.valueJson,
            bodyJson.valueJson,
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
        put: (key, bytes) => {
          let bytesBase64;
          try {
            bytesBase64 = __pax_bytes_to_base64(bytes);
          } catch (err) {
            return Promise.resolve(
              __pax_blob_storage_unavailable(
                err && typeof err.message === "string" ? err.message : String(err),
              ),
            );
          }
          const responseJson = __pax_c_blob_put.applySyncPromise(undefined, [
            String(key),
            bytesBase64,
          ]);
          return Promise.resolve(JSON.parse(responseJson));
        },
        get: (key) => {
          const responseJson = __pax_c_blob_get.applySyncPromise(undefined, [String(key)]);
          const response = JSON.parse(responseJson);
          return Promise.resolve(
            response.found && typeof response.bytesBase64 === "string"
              ? __pax_base64_to_bytes(response.bytesBase64)
              : null,
          );
        },
        delete: (key) => {
          const responseJson = __pax_c_blob_delete.applySyncPromise(undefined, [String(key)]);
          return Promise.resolve(JSON.parse(responseJson));
        },
        list: (prefix) => {
          const responseJson = __pax_c_blob_list.applySyncPromise(undefined, [
            typeof prefix === "string" ? prefix : null,
          ]);
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
  | "onCapacityWarning"
  | "onHostEvent";

async function invokeHandler(handlerName: HandlerName, payload: unknown): Promise<boolean> {
  if (!bundleExports || !context) return true;
  const fnRef = (await bundleExports.get(handlerName, { reference: true })) as
    | ivm.Reference
    | undefined;
  if (!fnRef) return true;
  if (fnRef.typeof === "undefined" || fnRef.typeof === "null") return true;
  if (fnRef.typeof !== "function") {
    emitHandlerError(
      handlerName,
      `${handlerName} export is ${fnRef.typeof}, not a function`,
      0,
    );
    return false;
  }
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
  type: "state.write",
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
      case PARENT_TO_CHILD.blobPutResponse:
        completeParentRequest(raw.requestId, raw.payload.response);
        return;
      case PARENT_TO_CHILD.blobGetResponse:
        completeParentRequest(raw.requestId, raw.payload);
        return;
      case PARENT_TO_CHILD.blobDeleteResponse:
        completeParentRequest(raw.requestId, raw.payload);
        return;
      case PARENT_TO_CHILD.blobListResponse:
        completeParentRequest(raw.requestId, raw.payload.items);
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
      case PARENT_TO_CHILD.onHostEvent:
        await invokeHandler("onHostEvent", raw.payload);
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
