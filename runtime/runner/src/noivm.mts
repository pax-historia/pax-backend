import vm from "node:vm";

import type {
  ApiInvokeResponse,
  BlobListItem,
  ComputeBudgetSnapshot,
  ConnectedSessionSnapshot,
  RunnerAssignment,
  RunnerInvoke,
  RunnerTelemetry,
  StorageReadResponsePayload,
  StorageWriteResponse,
  WsSendResponse,
} from "@pax-backend/ipc-protocol";
import type { BundleDefinition, SubstrateContext } from "@pax-backend/runtime-sdk";

import type { BrokerBridge, RunnerProcess } from "./index.mjs";

interface NoIvmGame {
  readonly assignment: RunnerAssignment;
  readonly context: vm.Context;
  readonly bundle: BundleDefinition;
  readonly c: SubstrateContext;
  readonly startedAt: number;
  cpuMs: number;
  memoryBytes: number;
}

interface PaxGlobal {
  __pax_install?: (bundle: BundleDefinition) => void;
  __pax_bundle?: BundleDefinition | null;
  c?: SubstrateContext;
  console?: Console;
}

export class NoIvmRunnerProcess implements RunnerProcess {
  readonly kind = "noivm" as const;
  readonly assignedGames = new Set<string>();
  private readonly games = new Map<string, NoIvmGame>();

  constructor(
    readonly id: string,
    private readonly bridge: BrokerBridge,
  ) {}

  async assign(input: RunnerAssignment): Promise<void> {
    if (this.games.has(input.gameId)) throw new Error(`game ${input.gameId} is already assigned`);
    const c = makeContext(input, this.bridge);
    const sandbox: PaxGlobal = {
      __pax_bundle: null,
      __pax_install: (bundle) => {
        sandbox.__pax_bundle = bundle;
      },
      c,
      console: consoleProxy(input.gameId, this.bridge),
    };
    const context = vm.createContext(sandbox, {
      name: `pax-noivm-${input.gameId}`,
      codeGeneration: { strings: true, wasm: false },
    });
    const script = new vm.Script(input.bundleSource, {
      filename: `${input.bundleName}.bundle.js`,
    });
    script.runInContext(context, {
      timeout: input.handlerTimeoutMs,
      displayErrors: true,
    });
    if (!sandbox.__pax_bundle) throw new Error(`bundle ${input.bundleName} did not call __pax_install`);
    this.games.set(input.gameId, {
      assignment: input,
      context,
      bundle: sandbox.__pax_bundle,
      c,
      startedAt: Date.now(),
      cpuMs: 0,
      memoryBytes: 0,
    });
    this.assignedGames.add(input.gameId);
    await this.bridge.emit(input.gameId, "isolate.ready", {
      runnerId: this.id,
      bundleName: input.bundleName,
      bundleCompatTag: input.bundleCompatTag,
      runId: input.runId,
    });
  }

  async send(): Promise<void> {
    // The in-process no-ivm runner talks to the Broker through BrokerBridge.
    // Cross-process Runners consume BrokerToRunnerEnvelope directly.
  }

  async invoke(input: RunnerInvoke): Promise<unknown> {
    const game = this.requireGame(input.gameId);
    const started = performance.now();
    const handler = game.bundle[input.handler];
    if (handler === undefined) {
      await this.bridge.emit(input.gameId, "handler.complete", {
        handler: input.handler,
        durationMs: performance.now() - started,
        timeoutMs: input.timeoutMs,
      });
      this.emitTelemetry(game);
      return undefined;
    }
    if (typeof handler !== "function") throw new Error(`${input.handler} is not a function`);
    const invokeHandler = handler as (c: SubstrateContext, payload: unknown) => unknown | Promise<unknown>;
    try {
      await withTimeout(
        Promise.resolve(invokeHandler(game.c, jsonClone(input.payload))),
        input.timeoutMs,
        input.handler,
      );
      const durationMs = performance.now() - started;
      if (durationMs >= input.timeoutMs) {
        throw new Error(`${input.handler} timed out after ${input.timeoutMs}ms`);
      }
      game.cpuMs += durationMs;
      await this.bridge.emit(input.gameId, "handler.complete", {
        handler: input.handler,
        durationMs,
        timeoutMs: input.timeoutMs,
      });
      this.emitTelemetry(game);
      return undefined;
    } catch (err) {
      const durationMs = performance.now() - started;
      await this.bridge.emit(input.gameId, "handler.error", {
        handler: input.handler,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
        code: durationMs >= input.timeoutMs ? "handlerTimeout" : "handlerException",
        durationMs,
        timeoutMs: input.timeoutMs,
      });
      throw err;
    }
  }

  async release(gameId: string): Promise<void> {
    this.games.delete(gameId);
    this.assignedGames.delete(gameId);
  }

  async stop(): Promise<void> {
    this.games.clear();
    this.assignedGames.clear();
  }

  private requireGame(gameId: string): NoIvmGame {
    const game = this.games.get(gameId);
    if (!game) throw new Error(`game ${gameId} is not assigned to no-ivm runner ${this.id}`);
    return game;
  }

  private emitTelemetry(game: NoIvmGame): void {
    game.memoryBytes = process.memoryUsage().heapUsed;
    const telemetry: RunnerTelemetry = {
      gameId: game.assignment.gameId,
      runnerId: this.id,
      memoryBytes: game.memoryBytes,
      cpuMs: game.cpuMs,
      isolateCount: this.games.size,
    };
    this.bridge.emitTelemetry(telemetry);
  }
}

function makeContext(assignment: RunnerAssignment, bridge: BrokerBridge): SubstrateContext {
  let rngState = hashSeed(
    `${assignment.testSeed ?? "runtime"}:${assignment.gameId}:${assignment.bundleName}:${assignment.bundleCompatTag}`,
  );
  let now = 1_700_000_000_000 + (rngState % 1_000_000_000);
  const c: SubstrateContext = {
    rng: () => {
      rngState = (rngState + 0x6d2b79f5) >>> 0;
      let mixed = rngState;
      mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    },
    now: () => {
      now += 1;
      return now;
    },
    ws: {
      send: async (target, body) =>
        unwrapResponse<WsSendResponse>(
          await bridge.request(assignment.gameId, "ws.send", {
            target: jsonClone(target),
            body: jsonClone(body),
          }),
        ),
    },
    log: {
      emit: (payload) => {
        void bridge.emit(assignment.gameId, "log.emit", jsonClone(payload));
      },
    },
    metrics: {
      emit: (payload) => {
        void bridge.emit(assignment.gameId, "metrics.emit", jsonClone(payload));
      },
    },
    lifecycle: {
      requestSleep: () => {
        void bridge.emit(assignment.gameId, "lifecycle.requestSleep", {});
      },
    },
    api: {
      invoke: async (kind, args, options = {}) =>
        unwrapResponse<ApiInvokeResponse>(
          await bridge.request(assignment.gameId, "api.invoke", {
            kind,
            args: jsonClone(args),
            idempotencyKey: options.idempotencyKey,
          }),
        ),
    },
    players: {
      allowed: async () =>
        unwrapPlayers(
          await bridge.request(assignment.gameId, "players.allowed", {}),
        ),
      connected: async () =>
        unwrapConnected(
          await bridge.request(assignment.gameId, "players.connected", {}),
        ),
    },
    compute: {
      budget: async () =>
        unwrapBudget(
          await bridge.request(assignment.gameId, "compute.budget", {}),
        ),
    },
    state: {
      read: async () => {
        const response = await bridge.request(assignment.gameId, "state.read", {});
        const read = response as StorageReadResponsePayload;
        return read.found === false ? undefined : read.value;
      },
      write: async (value) =>
        unwrapResponse<StorageWriteResponse>(
          await bridge.request(assignment.gameId, "state.write", { value: jsonClone(value) }),
        ),
      flush: async () =>
        unwrapResponse<StorageWriteResponse>(
          await bridge.request(assignment.gameId, "state.flush", {}),
        ),
    },
    blob: {
      put: async (key, bytes) =>
        unwrapResponse<StorageWriteResponse>(
          await bridge.request(assignment.gameId, "blob.put", {
            key,
            bytesBase64: Buffer.from(bytes).toString("base64"),
          }),
        ),
      get: async (key) => {
        const response = await bridge.request(assignment.gameId, "blob.get", { key });
        const payload = response as { readonly found?: boolean; readonly bytesBase64?: string };
        return payload.found && payload.bytesBase64 ? Buffer.from(payload.bytesBase64, "base64") : null;
      },
      delete: async (key) =>
        (await bridge.request(assignment.gameId, "blob.delete", { key })) as { readonly ok: true },
      list: async (prefix) => {
        const response = await bridge.request(
          assignment.gameId,
          "blob.list",
          prefix === undefined ? {} : { prefix },
        );
        return (response as { readonly items: readonly BlobListItem[] }).items;
      },
    },
  };
  return deepFreeze(c);
}

function consoleProxy(gameId: string, bridge: BrokerBridge): Console {
  const emit = (level: string, args: readonly unknown[]): void => {
    void bridge.emit(gameId, "log.emit", {
      event: "console",
      source: "console",
      level,
      message: args.map((arg) => String(arg)).join(" "),
      args: args.map((arg) => jsonClone(arg)),
    });
  };
  return {
    ...console,
    debug: (...args: unknown[]) => emit("debug", args),
    log: (...args: unknown[]) => emit("log", args),
    info: (...args: unknown[]) => emit("info", args),
    warn: (...args: unknown[]) => emit("warn", args),
    error: (...args: unknown[]) => emit("error", args),
  } as Console;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function unwrapResponse<T>(value: unknown): T {
  if (value && typeof value === "object" && "response" in value) {
    return (value as { readonly response: T }).response;
  }
  return value as T;
}

function unwrapPlayers(value: unknown): readonly string[] {
  const payload = value as { readonly players?: readonly string[]; readonly items?: readonly string[] };
  return payload.players ?? payload.items ?? [];
}

function unwrapConnected(value: unknown): readonly ConnectedSessionSnapshot[] {
  const payload = value as {
    readonly players?: readonly ConnectedSessionSnapshot[];
    readonly items?: readonly ConnectedSessionSnapshot[];
  };
  return payload.players ?? payload.items ?? [];
}

function unwrapBudget(value: unknown): ComputeBudgetSnapshot {
  return (value as { readonly budget: ComputeBudgetSnapshot }).budget;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

function jsonClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
