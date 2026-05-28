// runtime/child-runner-ivm — the untrusted-JS runner.
//
// One node child_process per game. The bundle source is loaded into an
// isolated-vm Isolate; substrate context (c.ws.send / c.log.emit /
// c.lifecycle.requestSleep) is exposed as ivm bridges that post IPC
// envelopes back to the parent via process.send().
//
// Trust model (README §"Trust model"):
//  - No outbound network (parent forks us with a stripped env).
//  - No environment variables visible (parent passes only PATH + role).
//  - CPU/memory capped by ivm.Isolate({ memoryLimit }) + per-handler timeout.
//
// The child is unaware of WebSockets, Rivet, Fly, or anything outside its
// IPC. Everything it knows about the world arrives as a ParentToChildEnvelope.

import ivm from "isolated-vm";

import {
  type BootstrapPayload,
  CHILD_TO_PARENT,
  type ChildToParentEnvelope,
  type IpcEnvelope,
  PARENT_TO_CHILD,
  type ParentToChildEnvelope,
  envelope,
} from "@pax-backend/ipc-protocol";

const PER_HANDLER_TIMEOUT_MS = 1_000; // compute-plane cpu-ms-per-tick stub

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

async function bootstrapIsolate(cfg: BootstrapPayload): Promise<void> {
  isolate = new ivm.Isolate({ memoryLimit: cfg.memoryLimitMb });
  context = await isolate.createContext();
  const jail = context.global;

  // ivm contexts have no globalThis self-reference; bundles often expect one.
  await jail.set("global", jail.derefInto());

  // Expose the substrate context `c` as ivm bridges. Each method posts an
  // IPC envelope back; the parent dispatches.
  const cWsSend = new ivm.Reference((targetJson: string, bodyJson: string) => {
    try {
      const target = JSON.parse(targetJson);
      const body = JSON.parse(bodyJson);
      emitOne(CHILD_TO_PARENT.wsSend, { target, body });
    } catch (err) {
      panic("c.ws.send bridge failed", err);
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
  const cLifecycleRequestSleep = new ivm.Reference(() => {
    emitOne(CHILD_TO_PARENT.lifecycleRequestSleep, {});
  });

  await jail.set("__pax_c_ws_send", cWsSend);
  await jail.set("__pax_c_log_emit", cLogEmit);
  await jail.set("__pax_c_lifecycle_requestSleep", cLifecycleRequestSleep);

  // SDK-equivalent in the isolate. Bundles compiled via esbuild see
  // defineBundle bundled in directly; __pax_install is the only global the
  // ivm runtime injects to receive the compiled bundle's default export.
  await context.eval(
    `
    globalThis.__pax_bundle = null;
    globalThis.__pax_install = (bundle) => { globalThis.__pax_bundle = bundle; };
    globalThis.c = {
      ws: {
        send: (target, body) => __pax_c_ws_send.applySync(undefined, [JSON.stringify(target), JSON.stringify(body)]),
      },
      log: {
        emit: (payload) => __pax_c_log_emit.applySync(undefined, [JSON.stringify(payload)]),
      },
      lifecycle: {
        requestSleep: () => __pax_c_lifecycle_requestSleep.applySync(undefined, []),
      },
    };
  `,
  );

  // Compile + run the bundle source. Bundles are pre-compiled by
  // scripts/build/build-bundles.sh (esbuild → IIFE → __pax_install) and shipped to
  // the parent as plain script JS. ivm has no module loader, no async-top-
  // level, no fetch — that constraint is by design.
  try {
    await context.eval(cfg.bundleSource, { timeout: PER_HANDLER_TIMEOUT_MS });
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

async function invokeHandler(handlerName: HandlerName, payload: unknown): Promise<void> {
  if (!bundleExports || !context) return;
  const fnRef = (await bundleExports.get(handlerName, { reference: true })) as
    | ivm.Reference
    | undefined;
  if (!fnRef) return;
  const cRef = (await context.global.get("c", { reference: true })) as ivm.Reference;
  try {
    await fnRef.apply(
      undefined,
      [cRef.derefInto(), new ivm.ExternalCopy(payload).copyInto()],
      { timeout: PER_HANDLER_TIMEOUT_MS },
    );
  } catch (err) {
    const errStr =
      err instanceof Error ? err.stack ?? err.message : JSON.stringify(err);
    emitOne("child.handlerError", { handler: handlerName, error: errStr });
  }
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
      case PARENT_TO_CHILD.onWake:
        await invokeHandler("onWake", raw.payload);
        return;
      case PARENT_TO_CHILD.onSleep:
        await invokeHandler("onSleep", raw.payload);
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
