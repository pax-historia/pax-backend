import ivm from "isolated-vm";

import type {
  RunnerAssignment,
  RunnerInvoke,
  RunnerTelemetry,
} from "@pax-backend/ipc-protocol";

import type { BrokerBridge, RunnerProcess } from "./index.mjs";

interface IvmGame {
  readonly assignment: RunnerAssignment;
  readonly isolate: ivm.Isolate;
  readonly context: ivm.Context;
  readonly bundleExports: ivm.Reference;
  cpuMs: number;
  memoryBytes: number;
}

export class IvmRunnerProcess implements RunnerProcess {
  readonly kind = "ivm" as const;
  readonly assignedGames = new Set<string>();
  private readonly games = new Map<string, IvmGame>();

  constructor(
    readonly id: string,
    private readonly bridge: BrokerBridge,
  ) {}

  async assign(input: RunnerAssignment): Promise<void> {
    if (this.games.has(input.gameId)) throw new Error(`game ${input.gameId} is already assigned`);
    const isolate = new ivm.Isolate({ memoryLimit: input.memoryLimitMb });
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set("global", jail.derefInto());

    const deterministic = deterministicRuntime(input);
    await jail.set("__pax_bridge_request", new ivm.Reference(async (channel: string, payloadJson: string) => {
      const payload = JSON.parse(payloadJson) as unknown;
      const response = await this.bridge.request(input.gameId, channel, payload);
      return JSON.stringify(response);
    }));
    await jail.set("__pax_bridge_emit", new ivm.Reference(async (channel: string, payloadJson: string) => {
      const payload = JSON.parse(payloadJson) as unknown;
      await this.bridge.emit(input.gameId, channel, payload);
    }));
    await jail.set("__pax_rng", new ivm.Reference(() => deterministic.rng()));
    await jail.set("__pax_now", new ivm.Reference(() => deterministic.now()));
    await context.eval(isolateBootstrapSource(), { timeout: input.handlerTimeoutMs });

    try {
      await context.eval(input.bundleSource, { timeout: input.handlerTimeoutMs });
    } catch (err) {
      isolate.dispose();
      throw err;
    }
    const bundleExports = (await context.global.get("__pax_bundle", { reference: true })) as ivm.Reference | undefined;
    if (!bundleExports) {
      isolate.dispose();
      throw new Error(`bundle ${input.bundleName} did not call __pax_install`);
    }
    this.games.set(input.gameId, {
      assignment: input,
      isolate,
      context,
      bundleExports,
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
    // Direct in-process use is driven by BrokerBridge. The child-process
    // wrapper consumes BrokerToRunnerEnvelope and resolves pending requests.
  }

  async invoke(input: RunnerInvoke): Promise<unknown> {
    const game = this.requireGame(input.gameId);
    const fnRef = (await game.bundleExports.get(input.handler, { reference: true })) as ivm.Reference | undefined;
    if (!fnRef || fnRef.typeof === "undefined" || fnRef.typeof === "null") return undefined;
    if (fnRef.typeof !== "function") throw new Error(`${input.handler} is ${fnRef.typeof}, not a function`);
    const cRef = (await game.context.global.get("c", { reference: true })) as ivm.Reference;
    const startedCpu = game.isolate.cpuTime;
    const started = performance.now();
    try {
      await fnRef.apply(
        undefined,
        [cRef.derefInto(), new ivm.ExternalCopy(jsonClone(input.payload)).copyInto()],
        { timeout: input.timeoutMs, result: { promise: true } },
      );
      const durationMs = performance.now() - started;
      game.cpuMs += Number(game.isolate.cpuTime - startedCpu) / 1_000_000;
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
        code: durationMs >= input.timeoutMs ? "handlerTimeout" : "handlerError",
        durationMs,
        timeoutMs: input.timeoutMs,
      });
      throw err;
    }
  }

  async release(gameId: string): Promise<void> {
    const game = this.games.get(gameId);
    if (!game) return;
    game.isolate.dispose();
    this.games.delete(gameId);
    this.assignedGames.delete(gameId);
  }

  async stop(): Promise<void> {
    for (const game of this.games.values()) game.isolate.dispose();
    this.games.clear();
    this.assignedGames.clear();
  }

  private requireGame(gameId: string): IvmGame {
    const game = this.games.get(gameId);
    if (!game) throw new Error(`game ${gameId} is not assigned to ivm runner ${this.id}`);
    return game;
  }

  private emitTelemetry(game: IvmGame): void {
    const heap = game.isolate.getHeapStatisticsSync();
    game.memoryBytes = heap.used_heap_size + heap.externally_allocated_size;
    const telemetry: RunnerTelemetry = {
      gameId: game.assignment.gameId,
      runnerId: this.id,
      memoryBytes: game.memoryBytes,
      cpuMs: game.cpuMs,
      isolateCount: this.games.size,
    };
    this.bridge.emitTelemetry(telemetry);
    void this.bridge.emit(game.assignment.gameId, "isolate.counters", {
      ...telemetry,
      heapUsedBytes: heap.used_heap_size,
      heapLimitBytes: heap.heap_size_limit,
      wallTimeMs: Number(game.isolate.wallTime) / 1_000_000,
    });
  }
}

function isolateBootstrapSource(): string {
  return `
    globalThis.__pax_bundle = null;
    globalThis.__pax_install = (bundle) => { globalThis.__pax_bundle = bundle; };

    const __pax_request = async (channel, payload = {}) => {
      const json = await __pax_bridge_request.apply(undefined, [
        channel,
        JSON.stringify(payload),
      ], { result: { promise: true } });
      return JSON.parse(json);
    };
    const __pax_emit = (channel, payload = {}) => {
      void __pax_bridge_emit.apply(undefined, [
        channel,
        JSON.stringify(payload),
      ], { result: { promise: true } });
    };
    const __pax_unwrap_response = (value) =>
      value && typeof value === "object" && "response" in value ? value.response : value;
    const __pax_base64_chars =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const __pax_bytes_to_base64 = (bytes) => {
      if (!(bytes instanceof Uint8Array)) throw new Error("bytes must be Uint8Array");
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
        if (value < 0) throw new Error("invalid base64");
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
    const __pax_safe_json = (value) => JSON.parse(JSON.stringify(value));
    const __pax_console_emit = (level, args) => {
      __pax_emit("log.emit", {
        event: "console",
        source: "console",
        level,
        message: args.map((arg) => String(arg)).join(" "),
        args: args.map((arg) => {
          try { return __pax_safe_json(arg); } catch { return String(arg); }
        }),
      });
    };

    globalThis.console = Object.assign(globalThis.console || {}, {
      debug: (...args) => __pax_console_emit("debug", args),
      log: (...args) => __pax_console_emit("log", args),
      info: (...args) => __pax_console_emit("info", args),
      warn: (...args) => __pax_console_emit("warn", args),
      error: (...args) => __pax_console_emit("error", args),
    });

    const c = {
      rng: () => __pax_rng.applySync(undefined, []),
      now: () => __pax_now.applySync(undefined, []),
      ws: {
        send: async (target, body) => __pax_unwrap_response(
          await __pax_request("ws.send", {
            target: __pax_safe_json(target),
            body: __pax_safe_json(body),
          })
        ),
      },
      log: { emit: (payload) => __pax_emit("log.emit", __pax_safe_json(payload)) },
      metrics: { emit: (payload) => __pax_emit("metrics.emit", __pax_safe_json(payload)) },
      lifecycle: { requestSleep: () => __pax_emit("lifecycle.requestSleep", {}) },
      api: {
        invoke: async (kind, args, options = {}) => __pax_unwrap_response(
          await __pax_request("api.invoke", {
            kind,
            args: __pax_safe_json(args),
            idempotencyKey: options.idempotencyKey,
          })
        ),
      },
      players: {
        allowed: async () => {
          const response = await __pax_request("players.allowed", {});
          return response.players || response.items || [];
        },
        connected: async () => {
          const response = await __pax_request("players.connected", {});
          return response.players || response.items || [];
        },
      },
      compute: {
        budget: async () => (await __pax_request("compute.budget", {})).budget,
      },
      state: {
        read: async () => {
          const response = await __pax_request("state.read", {});
          return response.found === false ? undefined : response.value;
        },
        write: async (value) => __pax_unwrap_response(
          await __pax_request("state.write", { value: __pax_safe_json(value) })
        ),
        flush: async () => __pax_unwrap_response(await __pax_request("state.flush", {})),
      },
      blob: {
        put: async (key, bytes) => __pax_unwrap_response(
          await __pax_request("blob.put", {
            key,
            bytesBase64: __pax_bytes_to_base64(bytes),
          })
        ),
        get: async (key) => {
          const response = await __pax_request("blob.get", { key });
          return response.found && response.bytesBase64
            ? __pax_base64_to_bytes(response.bytesBase64)
            : null;
        },
        delete: async (key) => __pax_request("blob.delete", { key }),
        list: async (prefix) => (await __pax_request(
          "blob.list",
          typeof prefix === "string" ? { prefix } : {},
        )).items,
      },
    };
    const __pax_deep_freeze = (value) => {
      Object.freeze(value);
      for (const nested of Object.values(value)) {
        if (nested && typeof nested === "object" && !Object.isFrozen(nested)) __pax_deep_freeze(nested);
      }
      return value;
    };
    globalThis.c = __pax_deep_freeze(c);
  `;
}

function deterministicRuntime(input: RunnerAssignment): { readonly rng: () => number; readonly now: () => number } {
  let rngState = hashSeed(
    `${input.testSeed ?? "runtime"}:${input.gameId}:${input.bundleName}:${input.bundleCompatTag}`,
  );
  let now = 1_700_000_000_000 + (rngState % 1_000_000_000);
  return {
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
  };
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
