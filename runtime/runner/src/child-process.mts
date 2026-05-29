import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  BROKER_TO_RUNNER,
  RUNTIME_CONTRACT_VERSION,
  RUNNER_TO_BROKER,
  bridgeEnvelope,
  runnerControlEnvelope,
  type BrokerToRunnerEnvelope,
  type IsolateCountersPayload,
  type RunnerAssignment,
  type RunnerInvoke,
  type RunnerKind,
  type RunnerTelemetry,
  type RunnerToBrokerEnvelope,
  type RuntimeHandlerName,
} from "@pax-backend/ipc-protocol";

import { IvmRunnerProcess } from "./ivm.mjs";
import type { BrokerBridge, RunnerProcess } from "./index.mjs";
import { NoIvmRunnerProcess } from "./noivm.mjs";

export type RunnerEnvelopeHandler = (
  envelope: RunnerToBrokerEnvelope,
  runner: ChildProcessRunnerProcess,
) => void | Promise<void>;

export interface RunnerCrashEvent {
  readonly runnerId: string;
  readonly affectedGameIds: readonly string[];
  readonly maxAssignedGames: number;
  readonly code: number | null;
  readonly signal: string | null;
}

export type RunnerCrashHandler = (
  event: RunnerCrashEvent,
  runner: ChildProcessRunnerProcess,
) => void | Promise<void>;

export interface ChildProcessRunnerProcessOptions {
  readonly id: string;
  readonly kind: RunnerKind;
  readonly maxAssignedGames: number;
  readonly child: ChildProcess;
  readonly onEnvelope: RunnerEnvelopeHandler;
  readonly onCrash?: RunnerCrashHandler;
  readonly assignTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

export interface SpawnRunnerChildProcessOptions {
  readonly id: string;
  readonly kind: RunnerKind;
  readonly onEnvelope: RunnerEnvelopeHandler;
  readonly onCrash?: RunnerCrashHandler;
  readonly modulePath?: string | URL;
  readonly argv?: readonly string[];
  readonly execArgv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly maxAssignedGames?: number;
  readonly runtimeContractsSupported?: readonly [number, number];
  readonly assignTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  readonly bridgeRequestTimeoutMs?: number;
  readonly defaultHandlerTimeoutMs?: number;
}

export interface RunnerChildProcessOptions {
  readonly id?: string;
  readonly kind?: RunnerKind;
  readonly maxAssignedGames?: number;
  readonly runtimeContractsSupported?: readonly [number, number];
  readonly requestTimeoutMs?: number;
  readonly defaultHandlerTimeoutMs?: number;
}

const RUNNER_CHILD_BOOTSTRAP_ENV_KEYS = [
  "CI",
  "FORCE_COLOR",
  "HOME",
  "NO_COLOR",
  "PATH",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
] as const;

interface PendingOperation {
  readonly label: string;
  readonly gameId?: string;
  readonly timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface ResponseRequestContext {
  readonly gameId: string;
  readonly requestId: string;
  readonly responseTypes: ReadonlySet<string>;
}

export class ChildProcessRunnerProcess implements RunnerProcess {
  readonly id: string;
  readonly kind: RunnerKind;
  readonly maxAssignedGames: number;
  readonly assignedGames = new Set<string>();

  private readonly child: ChildProcess;
  private readonly onEnvelope: RunnerEnvelopeHandler;
  private readonly onCrash: RunnerCrashHandler | undefined;
  private readonly pending = new Map<string, PendingOperation>();
  private readonly assignTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private exited = false;
  private stopping = false;

  constructor(options: ChildProcessRunnerProcessOptions) {
    this.id = options.id;
    this.kind = options.kind;
    this.maxAssignedGames = options.maxAssignedGames;
    this.child = options.child;
    this.onEnvelope = options.onEnvelope;
    this.onCrash = options.onCrash;
    this.assignTimeoutMs = options.assignTimeoutMs ?? 30_000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;

    this.child.on("message", (message: unknown) => {
      void this.handleMessage(message).catch((err) => {
        this.rejectPendingForMessage(message, coerceError(err));
      });
    });
    this.child.once("error", (err) => {
      this.failAll(new Error(`runner child ${this.id} failed: ${err.message}`));
    });
    this.child.once("exit", (code, signal) => {
      const affectedGameIds = [...this.assignedGames].sort();
      this.exited = true;
      this.assignedGames.clear();
      this.failAll(new Error(`runner child ${this.id} exited code=${code ?? "null"} signal=${signal ?? "null"}`));
      if (!this.stopping && affectedGameIds.length > 0) {
        void this.onCrash?.(
          {
            runnerId: this.id,
            affectedGameIds,
            maxAssignedGames: this.maxAssignedGames,
            code: code ?? null,
            signal: signal ?? null,
          },
          this,
        );
      }
    });
  }

  async assign(input: RunnerAssignment): Promise<void> {
    if (this.assignedGames.has(input.gameId)) throw new Error(`game ${input.gameId} is already assigned`);
    const requestId = randomUUID();
    const wait = this.waitFor<void>(requestId, `assign ${input.gameId}`, this.assignTimeoutMs, input.gameId);
    try {
      await this.sendToChild(
        bridgeEnvelope(input.gameId, BROKER_TO_RUNNER.assign, input, { requestId }) as BrokerToRunnerEnvelope,
      );
    } catch (err) {
      this.rejectPending(requestId, coerceError(err));
    }
    await wait;
    this.assignedGames.add(input.gameId);
  }

  async send(envelope: BrokerToRunnerEnvelope): Promise<void> {
    await this.sendToChild(envelope);
  }

  async invoke(input: RunnerInvoke): Promise<unknown> {
    if (!this.assignedGames.has(input.gameId)) {
      throw new Error(`game ${input.gameId} is not assigned to runner child ${this.id}`);
    }
    const requestId = randomUUID();
    const timeoutMs = input.timeoutMs + 5_000;
    const wait = this.waitFor<unknown>(requestId, `${input.handler} ${input.gameId}`, timeoutMs, input.gameId);
    try {
      const envelope = {
        ...bridgeEnvelope(input.gameId, input.handler, input.payload, {
          requestId,
          traceId: input.traceId,
        }),
        timeoutMs: input.timeoutMs,
      } as BrokerToRunnerEnvelope;
      await this.sendToChild(envelope);
    } catch (err) {
      this.rejectPending(requestId, coerceError(err));
    }
    return await wait;
  }

  async release(gameId: string): Promise<void> {
    if (!this.assignedGames.has(gameId)) return;
    await this.sendToChild(
      bridgeEnvelope(gameId, BROKER_TO_RUNNER.release, {}) as BrokerToRunnerEnvelope,
    );
    this.assignedGames.delete(gameId);
    this.rejectGamePending(gameId, new Error(`game ${gameId} was released`));
  }

  async stop(): Promise<void> {
    if (this.exited) return;
    this.stopping = true;
    this.failAll(new Error(`runner child ${this.id} is stopping`));
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.exited) this.child.kill("SIGKILL");
        resolve();
      }, this.stopTimeoutMs);
      timer.unref();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  crashForTest(): boolean {
    if (this.exited) return false;
    return this.child.kill("SIGKILL");
  }

  private async handleMessage(message: unknown): Promise<void> {
    const envelope = isRunnerToBrokerEnvelope(message)
      ? message
      : runnerControlEnvelope(RUNNER_TO_BROKER.runnerUnknownMessage, {
        type: messageType(message),
        detail: safeDetail(message),
      });

    try {
      await this.onEnvelope(envelope, this);
    } catch (err) {
      this.rejectPendingForEnvelope(envelope, coerceError(err));
      return;
    }
    this.completePendingForEnvelope(envelope);
  }

  private completePendingForEnvelope(envelope: RunnerToBrokerEnvelope): void {
    const requestId = "requestId" in envelope ? envelope.requestId : undefined;
    if (!requestId) return;
    const pending = this.pending.get(requestId);
    if (!pending) return;

    if (envelope.type === RUNNER_TO_BROKER.handlerError || envelope.type === RUNNER_TO_BROKER.isolateFatal) {
      this.rejectPending(requestId, envelopeError(envelope));
      return;
    }
    if (envelope.type === RUNNER_TO_BROKER.handlerComplete || envelope.type === RUNNER_TO_BROKER.isolateReady) {
      this.resolvePending(requestId, undefined);
    }
  }

  private rejectPendingForEnvelope(envelope: RunnerToBrokerEnvelope, err: Error): void {
    const requestId = "requestId" in envelope ? envelope.requestId : undefined;
    if (requestId) this.rejectPending(requestId, err);
  }

  private rejectPendingForMessage(message: unknown, err: Error): void {
    if (isObject(message) && typeof message["requestId"] === "string") {
      this.rejectPending(message["requestId"], err);
    }
  }

  private async sendToChild(envelope: BrokerToRunnerEnvelope): Promise<void> {
    if (this.exited || !this.child.connected) {
      throw new Error(`runner child ${this.id} is not connected`);
    }
    await new Promise<void>((resolve, reject) => {
      try {
        this.child.send(envelope, (err) => {
          if (err) reject(err);
          else resolve();
        });
      } catch (err) {
        reject(coerceError(err));
      }
    });
  }

  private waitFor<T>(requestId: string, label: string, timeoutMs: number, gameId?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`runner child ${this.id} timed out waiting for ${label}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, {
        label,
        gameId,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
  }

  private resolvePending(requestId: string, value: unknown): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(value);
  }

  private rejectPending(requestId: string, err: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(err);
  }

  private rejectGamePending(gameId: string, err: Error): void {
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.gameId === gameId) this.rejectPending(requestId, err);
    }
  }

  private failAll(err: Error): void {
    for (const requestId of [...this.pending.keys()]) this.rejectPending(requestId, err);
  }
}

export function spawnRunnerChildProcess(options: SpawnRunnerChildProcessOptions): ChildProcessRunnerProcess {
  const modulePath = options.modulePath
    ? pathFromModuleOption(options.modulePath)
    : fileURLToPath(new URL("./child-process.mjs", import.meta.url));
  const runtimeContractsSupported = options.runtimeContractsSupported ?? [
    RUNTIME_CONTRACT_VERSION,
    RUNTIME_CONTRACT_VERSION,
  ] as const;
  const child = fork(modulePath, [...(options.argv ?? [])], {
    env: buildRunnerChildEnv(options, runtimeContractsSupported),
    execArgv: options.execArgv ? [...options.execArgv] : process.execArgv,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  return new ChildProcessRunnerProcess({
    id: options.id,
    kind: options.kind,
    maxAssignedGames: options.maxAssignedGames ?? 128,
    child,
    onEnvelope: options.onEnvelope,
    onCrash: options.onCrash,
    assignTimeoutMs: options.assignTimeoutMs,
    stopTimeoutMs: options.stopTimeoutMs,
  });
}

export function buildRunnerChildEnv(
  options: Pick<
    SpawnRunnerChildProcessOptions,
    | "id"
    | "kind"
    | "env"
    | "maxAssignedGames"
    | "bridgeRequestTimeoutMs"
    | "defaultHandlerTimeoutMs"
  >,
  runtimeContractsSupported: readonly [number, number] = [
    RUNTIME_CONTRACT_VERSION,
    RUNTIME_CONTRACT_VERSION,
  ],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  copyRunnerBootstrapEnv(env, process.env);
  copyRunnerBootstrapEnv(env, options.env ?? {});
  return {
    ...env,
    PAX_RUNNER_CHILD: "1",
    PAX_RUNNER_ID: options.id,
    PAX_RUNNER_KIND: options.kind,
    PAX_RUNNER_MAX_ASSIGNED_GAMES: String(options.maxAssignedGames ?? 128),
    PAX_RUNNER_CONTRACT_MIN: String(runtimeContractsSupported[0]),
    PAX_RUNNER_CONTRACT_MAX: String(runtimeContractsSupported[1]),
    PAX_RUNNER_REQUEST_TIMEOUT_MS: String(options.bridgeRequestTimeoutMs ?? 30_000),
    PAX_RUNNER_DEFAULT_HANDLER_TIMEOUT_MS: String(options.defaultHandlerTimeoutMs ?? 1_000),
  };
}

function copyRunnerBootstrapEnv(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
): void {
  for (const key of RUNNER_CHILD_BOOTSTRAP_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) target[key] = value;
  }
}

export class RunnerChildHost {
  readonly id: string;
  readonly kind: RunnerKind;

  private readonly maxAssignedGames: number;
  private readonly runtimeContractsSupported: readonly [number, number];
  private readonly defaultHandlerTimeoutMs: number;
  private readonly bridge: ProcessBrokerBridge;
  private readonly runner: RunnerProcess;
  private readonly assignments = new Map<string, RunnerAssignment>();
  private started = false;

  constructor(options: RunnerChildProcessOptions = {}) {
    this.id = options.id ?? process.env["PAX_RUNNER_ID"] ?? `runner-${process.pid}`;
    this.kind = options.kind ?? parseRunnerKind(process.env["PAX_RUNNER_KIND"]);
    this.maxAssignedGames = options.maxAssignedGames ?? parseIntegerEnv("PAX_RUNNER_MAX_ASSIGNED_GAMES", 128);
    this.runtimeContractsSupported = options.runtimeContractsSupported ?? parseRuntimeContractsSupported();
    this.defaultHandlerTimeoutMs = options.defaultHandlerTimeoutMs
      ?? parseIntegerEnv("PAX_RUNNER_DEFAULT_HANDLER_TIMEOUT_MS", 1_000);
    this.bridge = new ProcessBrokerBridge({
      requestTimeoutMs: options.requestTimeoutMs ?? parseIntegerEnv("PAX_RUNNER_REQUEST_TIMEOUT_MS", 30_000),
    });
    this.runner = this.kind === "ivm"
      ? new IvmRunnerProcess(this.id, this.bridge)
      : new NoIvmRunnerProcess(this.id, this.bridge);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    process.on("message", (message: unknown) => {
      void this.handleBrokerMessage(message).catch((err) => {
        this.sendUnknown(message, err);
      });
    });
    process.once("disconnect", () => {
      void this.shutdown(0);
    });
    process.once("SIGTERM", () => {
      void this.shutdown(0);
    });
    this.sendRunnerReady();
  }

  private async handleBrokerMessage(message: unknown): Promise<void> {
    if (!isBrokerToRunnerEnvelope(message)) {
      this.sendUnknown(message);
      return;
    }
    if (this.bridge.resolveBrokerResponse(message)) return;

    if (message.type === BROKER_TO_RUNNER.assign) {
      await this.assign(message);
      return;
    }
    if (message.type === BROKER_TO_RUNNER.release) {
      await this.release(message.gameId);
      return;
    }
    if (isRuntimeHandler(message.type)) {
      await this.invoke(message as Extract<BrokerToRunnerEnvelope, { type: RuntimeHandlerName }>);
      return;
    }
    this.sendUnknown(message);
  }

  private async assign(envelope: Extract<BrokerToRunnerEnvelope, { type: "assign" }>): Promise<void> {
    const assignment = toRunnerAssignment(envelope);
    try {
      if (this.assignments.size >= this.maxAssignedGames) {
        throw new Error(`runner ${this.id} assignment capacity exceeded`);
      }
      await this.bridge.withResponseRequestId(
        envelope.gameId,
        envelope.requestId,
        [RUNNER_TO_BROKER.isolateReady, RUNNER_TO_BROKER.isolateFatal],
        async () => {
          await this.runner.assign(assignment);
        },
      );
      this.assignments.set(envelope.gameId, assignment);
    } catch (err) {
      this.assignments.delete(envelope.gameId);
      this.sendFatal(envelope.gameId, err, envelope.requestId);
    }
  }

  private async release(gameId: string): Promise<void> {
    await this.runner.release(gameId);
    this.assignments.delete(gameId);
  }

  private async invoke(envelope: Extract<BrokerToRunnerEnvelope, { type: RuntimeHandlerName }>): Promise<void> {
    const assignment = this.assignments.get(envelope.gameId);
    if (!assignment) {
      this.sendFatal(envelope.gameId, new Error(`game ${envelope.gameId} is not assigned`), envelope.requestId);
      return;
    }
    const timeoutMs = envelopeTimeoutMs(envelope) ?? assignment.handlerTimeoutMs ?? this.defaultHandlerTimeoutMs;
    try {
      await this.bridge.withResponseRequestId(
        envelope.gameId,
        envelope.requestId,
        [RUNNER_TO_BROKER.handlerComplete, RUNNER_TO_BROKER.handlerError],
        async () => {
          await this.runner.invoke({
            gameId: envelope.gameId,
            handler: envelope.type,
            payload: envelope.payload,
            timeoutMs,
            traceId: envelope.traceId,
          });
        },
      );
    } catch (err) {
      if (!this.bridge.hasEmittedRequestId(envelope.requestId)) {
        this.sendHandlerError(envelope.gameId, envelope.type, timeoutMs, err, envelope.requestId);
      }
    }
  }

  private sendRunnerReady(): void {
    sendRunnerEnvelope(
      runnerControlEnvelope(RUNNER_TO_BROKER.runnerReady, {
        runnerId: this.id,
        kind: this.kind,
        maxAssignedGames: this.maxAssignedGames,
        runtimeContractsSupported: this.runtimeContractsSupported,
        pid: process.pid,
      }),
    );
  }

  private sendFatal(gameId: string, err: unknown, requestId?: string): void {
    sendRunnerEnvelope(
      bridgeEnvelope(gameId, RUNNER_TO_BROKER.isolateFatal, {
        runnerId: this.id,
        message: "runner child operation failed",
        error: errorText(err),
        errorClass: "unknown",
      }, { requestId }) as RunnerToBrokerEnvelope,
    );
  }

  private sendHandlerError(
    gameId: string,
    handler: RuntimeHandlerName,
    timeoutMs: number,
    err: unknown,
    requestId?: string,
  ): void {
    sendRunnerEnvelope(
      bridgeEnvelope(gameId, RUNNER_TO_BROKER.handlerError, {
        handler,
        error: errorText(err),
        code: "handlerException",
        durationMs: 0,
        timeoutMs,
      }, { requestId }) as RunnerToBrokerEnvelope,
    );
  }

  private sendUnknown(message: unknown, err?: unknown): void {
    sendRunnerEnvelope(
      runnerControlEnvelope(RUNNER_TO_BROKER.runnerUnknownMessage, {
        type: messageType(message),
        detail: err ? { message: safeDetail(message), error: errorText(err) } : safeDetail(message),
      }),
    );
  }

  private async shutdown(exitCode: number): Promise<void> {
    await this.runner.stop();
    process.exit(exitCode);
  }
}

export function startRunnerChildProcess(options: RunnerChildProcessOptions = {}): RunnerChildHost {
  const host = new RunnerChildHost(options);
  host.start();
  return host;
}

class ProcessBrokerBridge implements BrokerBridge {
  private readonly pending = new Map<string, PendingOperation>();
  private readonly responseContexts: ResponseRequestContext[] = [];
  private readonly emittedRequestIds = new Set<string>();
  private readonly telemetryFallbacks = new Map<string, NodeJS.Immediate>();

  constructor(private readonly options: { readonly requestTimeoutMs: number }) {}

  async request(gameId: string, channel: string, payload: unknown): Promise<unknown> {
    const requestId = randomUUID();
    const wait = this.waitForBrokerResponse(requestId, `${channel} response`, gameId);
    try {
      this.sendBridgeEnvelope(gameId, channel, payload, requestId);
    } catch (err) {
      this.rejectPending(requestId, coerceError(err));
    }
    return await wait;
  }

  emit(gameId: string, channel: string, payload: unknown): void {
    if (channel === RUNNER_TO_BROKER.isolateCounters) this.cancelTelemetryFallback(gameId);
    const requestId = this.currentResponseRequestId(gameId, channel);
    this.sendBridgeEnvelope(gameId, channel, payload, requestId);
  }

  emitTelemetry(telemetry: RunnerTelemetry): void {
    const key = telemetryKey(telemetry.gameId, telemetry.runnerId);
    const existing = this.telemetryFallbacks.get(key);
    if (existing) clearImmediate(existing);

    const immediate = setImmediate(() => {
      this.telemetryFallbacks.delete(key);
      const payload: IsolateCountersPayload = {
        ...telemetry,
        heapUsedBytes: telemetry.memoryBytes,
        heapLimitBytes: telemetry.memoryBytes,
        wallTimeMs: 0,
      };
      this.sendBridgeEnvelope(telemetry.gameId, RUNNER_TO_BROKER.isolateCounters, payload);
    });
    immediate.unref();
    this.telemetryFallbacks.set(key, immediate);
  }

  resolveBrokerResponse(envelope: BrokerToRunnerEnvelope): boolean {
    if (!isBrokerResponseEnvelope(envelope)) return false;
    const requestId = envelope.requestId;
    if (!requestId) return true;
    const pending = this.pending.get(requestId);
    if (!pending) return true;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(envelope.payload);
    return true;
  }

  async withResponseRequestId<T>(
    gameId: string,
    requestId: string | undefined,
    responseTypes: readonly string[],
    callback: () => Promise<T>,
  ): Promise<T> {
    if (!requestId) return await callback();
    const context: ResponseRequestContext = {
      gameId,
      requestId,
      responseTypes: new Set(responseTypes),
    };
    this.responseContexts.push(context);
    try {
      return await callback();
    } finally {
      const index = this.responseContexts.indexOf(context);
      if (index >= 0) this.responseContexts.splice(index, 1);
    }
  }

  hasEmittedRequestId(requestId: string | undefined): boolean {
    return requestId ? this.emittedRequestIds.has(requestId) : false;
  }

  private sendBridgeEnvelope(gameId: string, channel: string, payload: unknown, requestId?: string): void {
    if (requestId) this.emittedRequestIds.add(requestId);
    sendRunnerEnvelope(
      bridgeEnvelope(gameId, channel, payload, { requestId }) as RunnerToBrokerEnvelope,
    );
  }

  private waitForBrokerResponse(requestId: string, label: string, gameId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`runner child timed out waiting for ${label}`));
      }, this.options.requestTimeoutMs);
      timer.unref();
      this.pending.set(requestId, {
        label,
        gameId,
        timer,
        resolve,
        reject,
      });
    });
  }

  private currentResponseRequestId(gameId: string, channel: string): string | undefined {
    for (let index = this.responseContexts.length - 1; index >= 0; index -= 1) {
      const context = this.responseContexts[index];
      if (context && context.gameId === gameId && context.responseTypes.has(channel)) {
        return context.requestId;
      }
    }
    return undefined;
  }

  private rejectPending(requestId: string, err: Error): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(err);
  }

  private cancelTelemetryFallback(gameId: string): void {
    for (const [key, immediate] of [...this.telemetryFallbacks]) {
      if (!key.startsWith(`${gameId}:`)) continue;
      clearImmediate(immediate);
      this.telemetryFallbacks.delete(key);
    }
  }
}

function sendRunnerEnvelope(envelope: RunnerToBrokerEnvelope): void {
  if (!process.send) throw new Error("runner child process was started without IPC");
  process.send(envelope);
}

function toRunnerAssignment(envelope: Extract<BrokerToRunnerEnvelope, { type: "assign" }>): RunnerAssignment {
  const payload = envelope.payload as RunnerAssignment;
  return {
    gameId: envelope.gameId,
    bundleName: payload.bundleName,
    bundleSource: payload.bundleSource,
    bundleCompatTag: payload.bundleCompatTag,
    runtimeContractRequired: payload.runtimeContractRequired ?? RUNTIME_CONTRACT_VERSION,
    runId: payload.runId,
    memoryLimitMb: payload.memoryLimitMb,
    handlerTimeoutMs: payload.handlerTimeoutMs,
    testSeed: payload.testSeed,
    generation: payload.generation,
  };
}

function isRuntimeHandler(type: string): type is RuntimeHandlerName {
  return type === BROKER_TO_RUNNER.onWake
    || type === BROKER_TO_RUNNER.onSleep
    || type === BROKER_TO_RUNNER.onPlayerConnect
    || type === BROKER_TO_RUNNER.onPlayerDisconnect
    || type === BROKER_TO_RUNNER.onPlayerMessage
    || type === BROKER_TO_RUNNER.onCapacityWarning
    || type === BROKER_TO_RUNNER.onHostEvent;
}

function isBrokerResponseEnvelope(envelope: BrokerToRunnerEnvelope): boolean {
  return envelope.type.endsWith(".response");
}

function envelopeTimeoutMs(envelope: BrokerToRunnerEnvelope): number | undefined {
  const timeoutMs = (envelope as { readonly timeoutMs?: unknown }).timeoutMs;
  return typeof timeoutMs === "number" ? timeoutMs : undefined;
}

function isBrokerToRunnerEnvelope(value: unknown): value is BrokerToRunnerEnvelope {
  return isObject(value)
    && value["version"] === RUNTIME_CONTRACT_VERSION
    && typeof value["type"] === "string"
    && typeof value["gameId"] === "string"
    && "payload" in value;
}

function isRunnerToBrokerEnvelope(value: unknown): value is RunnerToBrokerEnvelope {
  if (!isObject(value) || value["version"] !== RUNTIME_CONTRACT_VERSION || typeof value["type"] !== "string") {
    return false;
  }
  if (value["type"] === RUNNER_TO_BROKER.runnerReady || value["type"] === RUNNER_TO_BROKER.runnerUnknownMessage) {
    return "payload" in value;
  }
  return typeof value["gameId"] === "string" && "payload" in value;
}

function envelopeError(envelope: RunnerToBrokerEnvelope): Error {
  if (envelope.type === RUNNER_TO_BROKER.handlerError || envelope.type === RUNNER_TO_BROKER.isolateFatal) {
    return new Error(envelope.payload.error);
  }
  return new Error(`runner child ${envelope.type} failed`);
}

function pathFromModuleOption(modulePath: string | URL): string {
  return typeof modulePath === "string" ? modulePath : fileURLToPath(modulePath);
}

function parseRunnerKind(value: string | undefined): RunnerKind {
  return value === "noivm" ? "noivm" : "ivm";
}

function parseRuntimeContractsSupported(): readonly [number, number] {
  return [
    parseIntegerEnv("PAX_RUNNER_CONTRACT_MIN", RUNTIME_CONTRACT_VERSION),
    parseIntegerEnv("PAX_RUNNER_CONTRACT_MAX", RUNTIME_CONTRACT_VERSION),
  ];
}

function parseIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function coerceError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function errorText(value: unknown): string {
  const err = coerceError(value);
  return err.stack ?? err.message;
}

function messageType(value: unknown): string {
  return isObject(value) && typeof value["type"] === "string" ? value["type"] : typeof value;
}

function safeDetail(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
}

function telemetryKey(gameId: string, runnerId: string): string {
  return `${gameId}:${runnerId}`;
}

if (process.env["PAX_RUNNER_CHILD"] === "1") {
  startRunnerChildProcess();
}
