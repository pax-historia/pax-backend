import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import jwt, { type JwtPayload } from "jsonwebtoken";
import type { Logger } from "pino";
import WebSocket, { type RawData } from "ws";

import type { RunnerPool, RunnerProcess } from "@pax-backend/runner";
import type { GameStateSession, StateStore } from "@pax-backend/state-store";
import {
  DEFAULT_BLOB_BYTES_LIMIT,
  DEFAULT_BLOB_KEYS_LIMIT,
  DEFAULT_STATE_BYTES_LIMIT,
  RUNNER_TO_BROKER,
  bridgeEnvelope,
  generateSessionId,
  type ApiGatewayInvokeResult,
  type ApiInvokeRequest,
  type ApiInvokeResponse,
  type BlobGetIpcPayload,
  type BlobListIpcPayload,
  type BlobPutIpcPayload,
  type BrokerToRunnerEnvelope,
  type ComputeBudgetSnapshot,
  type ConnectedSessionSnapshot,
  type HostEventRecord,
  type OnSleepPayload,
  type RunnerToBrokerEnvelope,
  type RuntimeHandlerName,
  type StorageWriteResponse,
  type WsSendPayload,
  type WsSendResponse,
  type WsTarget,
} from "@pax-backend/ipc-protocol";

export interface BrokerBudgetLimits {
  readonly cpuMsPerTick: number;
  readonly memoryBytes: number;
  readonly bandwidthBytesPerSec: number;
  readonly wsMessagesPerSec: number;
  readonly stateBytes: number;
  readonly blobBytes: number;
  readonly blobKeys: number;
  readonly apiInvocationsPerMin: number;
}

export const DEFAULT_BROKER_BUDGETS: BrokerBudgetLimits = {
  cpuMsPerTick: 1_000,
  memoryBytes: 256 * 1024 * 1024,
  bandwidthBytesPerSec: 64 * 1024,
  wsMessagesPerSec: 50,
  stateBytes: DEFAULT_STATE_BYTES_LIMIT,
  blobBytes: DEFAULT_BLOB_BYTES_LIMIT,
  blobKeys: DEFAULT_BLOB_KEYS_LIMIT,
  apiInvocationsPerMin: 60,
};

export interface BrokerConfig {
  readonly shardId: string;
  readonly publicUrl: string;
  readonly jwtSecret: string;
  readonly runtimeContractsSupported: readonly [number, number];
  readonly capacity: {
    readonly maxActiveGames: number;
    readonly softWatermarkPct: number;
    readonly hardWatermarkPct: number;
  };
  readonly budgets?: Partial<BrokerBudgetLimits>;
  readonly defaultMemoryLimitMb?: number;
  readonly handlerTimeoutMs?: number;
  readonly sleepGraceMs?: number;
  readonly sleepDeadlineMs?: number;
  readonly maxInboundFrameBytes?: number;
  readonly capacityHeartbeatMs?: number;
}

export interface BrokerWakeInput {
  readonly gameId: string;
  readonly bundleName: string;
  readonly bundleSource: string;
  readonly bundleCompatTag: string;
  readonly runtimeContractRequired: number;
  readonly runId?: string | null;
  readonly blobCompatTag?: string;
  readonly memoryLimitMb?: number;
  readonly handlerTimeoutMs?: number;
  readonly testSeed?: number | string;
  readonly generation?: number;
}

export interface BrokerDependencies {
  readonly runners: RunnerPool;
  readonly stateStore: StateStore;
  readonly history: {
    write(event: Record<string, unknown>): Promise<void>;
  };
  readonly directory: {
    publishCapacity(row: BrokerCapacityRow): Promise<void>;
    removeShard(shardId: string): Promise<void>;
    claimActiveGame?(input: BrokerActiveGameClaim): Promise<void>;
    releaseActiveGame?(gameId: string, generation?: number): Promise<void>;
  };
  readonly allowedPlayers: {
    has(gameId: string, playerId: string): Promise<boolean>;
    list(gameId: string): Promise<readonly string[]>;
  };
  readonly gateway: {
    invoke(input: BrokerGatewayInvokeInput): Promise<ApiGatewayInvokeResult>;
  };
  readonly hostEvents?: {
    drain(gameId: string): Promise<readonly HostEventRecord[]>;
  };
  readonly bundles?: {
    resolveForGame(gameId: string): Promise<BrokerWakeInput | undefined>;
  };
  readonly ids?: {
    generateSessionId(): string;
  };
  readonly logger?: Pick<Logger, "debug" | "info" | "warn" | "error">;
  readonly now?: () => number;
}

export interface BrokerActiveGameClaim {
  readonly gameId: string;
  readonly shardId: string;
  readonly generation: number;
  readonly placedAt: number;
  readonly refreshedAt: number;
}

export interface BrokerGatewayInvokeInput extends ApiInvokeRequest {
  readonly gameId: string;
  readonly triggeringSessionId: string | null;
  readonly triggeringJwtClaims: Readonly<Record<string, unknown>> | null;
  readonly connectedSessions: readonly ConnectedSessionSnapshot[];
  readonly bundleName: string;
  readonly bundleCompatTag: string;
  readonly runId: string | null;
  readonly traceId: string | null;
  readonly replayMode?: boolean;
}

export interface BrokerCapacityRow {
  readonly shardId: string;
  readonly url: string;
  readonly status: "healthy" | "draining" | "unhealthy";
  readonly healthy: boolean;
  readonly acceptingWakes: boolean;
  readonly runtimeContractsSupported: readonly [number, number];
  readonly activeGames: number;
  readonly currentGameCount: number;
  readonly maxGames: number;
  readonly lastSeenAt: number;
}

export interface BrokerHealthSnapshot {
  readonly shardId: string;
  readonly started: boolean;
  readonly acceptingWakes: boolean;
  readonly activeGames: number;
  readonly connectedSessions: number;
  readonly capacity: BrokerCapacityRow;
}

interface PlacementClaims extends JwtPayload {
  readonly gameId?: unknown;
  readonly playerId?: unknown;
  readonly shardId?: unknown;
  readonly runId?: unknown;
  readonly traceId?: unknown;
}

interface VerifiedPlacementClaims extends JwtPayload, Readonly<Record<string, unknown>> {
  readonly gameId: string;
  readonly playerId: string;
  readonly shardId: string;
  readonly runId?: unknown;
  readonly traceId?: unknown;
}

interface BrokerSession {
  readonly sessionId: string;
  readonly gameId: string;
  readonly playerId: string;
  readonly jwtClaims: Readonly<Record<string, unknown>>;
  readonly connectedAt: number;
  seq: number;
  ws: WebSocket;
}

interface DispatchContext {
  readonly sessionId: string | null;
  readonly traceId: string | null;
}

interface BrokerGame {
  readonly gameId: string;
  readonly generation: number;
  readonly runner: RunnerProcess;
  readonly state: GameStateSession;
  readonly bundleName: string;
  readonly bundleCompatTag: string;
  readonly blobCompatTag?: string;
  readonly runId: string | null;
  readonly sessions: Map<string, BrokerSession>;
  readonly blobSizes: Map<string, number>;
  readonly budgets: GameBudgetState;
  sleepTimer?: NodeJS.Timeout;
  currentDispatch?: DispatchContext;
}

interface GameBudgetState {
  readonly wsBytes: SlidingWindowCounter;
  readonly wsMessages: SlidingWindowCounter;
  readonly apiInvocations: SlidingWindowCounter;
  stateBytes: number;
  blobBytes: number;
  blobKeys: number;
  cpuMs: number;
  memoryBytes: number;
}

export class Broker {
  private started = false;
  private acceptingWakes = true;
  private readonly games = new Map<string, BrokerGame>();
  private readonly budgetLimits: BrokerBudgetLimits;
  private capacityHeartbeat?: NodeJS.Timeout;

  constructor(
    private readonly config: BrokerConfig,
    private readonly deps: BrokerDependencies,
  ) {
    this.budgetLimits = { ...DEFAULT_BROKER_BUDGETS, ...config.budgets };
  }

  async start(): Promise<void> {
    this.started = true;
    this.acceptingWakes = true;
    await this.publishCapacity();
    this.startCapacityHeartbeat();
    await this.writeHistory({
      event: "broker.start",
      version: process.env["PAX_VERSION"] ?? "dev",
      runtimeContractsSupported: this.config.runtimeContractsSupported,
    });
  }

  async stop(): Promise<void> {
    this.acceptingWakes = false;
    this.stopCapacityHeartbeat();
    await this.publishCapacity();
    await Promise.all([...this.games.values()].map((game) => this.releaseGame(game, "shutdown")));
    await this.deps.runners.stop();
    await this.deps.directory.removeShard(this.config.shardId);
    this.started = false;
    await this.writeHistory({
      event: "broker.stop",
      intentional: true,
      reason: "shutdown",
    });
  }

  async requestDrain(reason = "admin"): Promise<void> {
    this.acceptingWakes = false;
    await this.publishCapacity();
    await this.writeHistory({ event: "broker.drain.started", reason });
    await Promise.all([...this.games.values()].map((game) => this.sleepGame(game, "shardEvicted")));
    await this.writeHistory({ event: "broker.drain.completed", reason });
  }

  async resumeWakes(reason = "admin"): Promise<void> {
    this.ensureStarted();
    this.acceptingWakes = true;
    await this.publishCapacity();
    await this.writeHistory({ event: "broker.drain.cancelled", reason });
  }

  async evictGame(gameId: string, reason: OnSleepPayload["reason"] = "evicted"): Promise<boolean> {
    const game = this.games.get(gameId);
    if (!game) return false;
    await this.sleepGame(game, reason);
    return true;
  }

  async wakeGame(input: BrokerWakeInput): Promise<void> {
    this.ensureStarted();
    if (this.games.has(input.gameId)) return;
    this.ensureRuntimeContract(input.runtimeContractRequired);
    this.ensureCapacity();

    const state = await this.deps.stateStore.openSession({
      gameId: input.gameId,
      bundleCompatTag: input.bundleCompatTag,
      blobCompatTag: input.blobCompatTag,
    });
    const stateBytes = state.readState();
    const blobSizes = await this.materializeBlobSizes(state);
    const runner = await this.deps.runners.assign({
      gameId: input.gameId,
      bundleName: input.bundleName,
      bundleSource: input.bundleSource,
      bundleCompatTag: input.bundleCompatTag,
      runtimeContractRequired: input.runtimeContractRequired,
      runId: input.runId ?? null,
      memoryLimitMb: input.memoryLimitMb ?? this.config.defaultMemoryLimitMb ?? 256,
      handlerTimeoutMs: input.handlerTimeoutMs ?? this.config.handlerTimeoutMs ?? 1_000,
      testSeed: input.testSeed,
      generation: input.generation,
    });

    const now = this.now();
    const generation = input.generation ?? now;
    const game: BrokerGame = {
      gameId: input.gameId,
      generation,
      runner,
      state,
      bundleName: input.bundleName,
      bundleCompatTag: input.bundleCompatTag,
      blobCompatTag: input.blobCompatTag,
      runId: input.runId ?? null,
      sessions: new Map(),
      blobSizes,
      budgets: {
        wsBytes: new SlidingWindowCounter(1_000),
        wsMessages: new SlidingWindowCounter(1_000),
        apiInvocations: new SlidingWindowCounter(60_000),
        stateBytes: stateBytes.byteLength,
        blobBytes: sumMapValues(blobSizes),
        blobKeys: blobSizes.size,
        cpuMs: 0,
        memoryBytes: 0,
      },
    };
    this.games.set(input.gameId, game);
    await this.deps.directory.claimActiveGame?.({
      gameId: input.gameId,
      shardId: this.config.shardId,
      generation,
      placedAt: now,
      refreshedAt: now,
    });
    await this.writeHistory({
      event: "game.woke",
      gameId: input.gameId,
      shardId: this.config.shardId,
      runnerId: runner.id,
      bundleName: input.bundleName,
      bundleCompatTag: input.bundleCompatTag,
      generation,
    });
    await this.invokeGameHandler(game, "onWake", {
      reason: stateBytes.byteLength === 0 ? "cold-start" : "cold-restart-from-storage",
      runId: game.runId,
      bundleName: game.bundleName,
      bundleCompatTag: game.bundleCompatTag,
      blobCompatTag: game.blobCompatTag,
      state: decodeJsonState(stateBytes),
    });
    await this.deliverQueuedHostEvents(game);
    await this.publishCapacity();
  }

  async acceptWebSocket(ws: WebSocket, rawUrl: string | URL): Promise<void> {
    this.ensureStarted();
    const url = typeof rawUrl === "string" ? new URL(rawUrl, this.config.publicUrl) : rawUrl;
    const token = url.searchParams.get("placementToken") ?? url.searchParams.get("token");
    if (!token) {
      ws.close(4401, "missing placement token");
      return;
    }

    let claims: VerifiedPlacementClaims;
    try {
      claims = this.verifyPlacementToken(token);
    } catch (err) {
      await this.writeHistory({
        event: "connection.refused",
        reason: "unauthorized",
        error: err instanceof Error ? err.message : String(err),
      });
      ws.close(4401, "unauthorized");
      return;
    }
    if (claims.shardId !== this.config.shardId) {
      await this.writeHistory({
        event: "connection.refused",
        gameId: claims.gameId,
        playerId: claims.playerId,
        reason: "wrongShard",
        tokenShardId: claims.shardId,
        shardId: this.config.shardId,
      });
      ws.close(4403, "wrong shard");
      return;
    }
    const routedGameId = url.searchParams.get("gameId");
    if (routedGameId && routedGameId !== claims.gameId) {
      await this.writeHistory({
        event: "connection.refused",
        gameId: claims.gameId,
        routedGameId,
        playerId: claims.playerId,
        reason: "wrongGame",
      });
      ws.close(4403, "wrong game");
      return;
    }

    const allowed = await this.deps.allowedPlayers.has(claims.gameId, claims.playerId);
    if (!allowed) {
      await this.writeHistory({
        event: "connection.refused",
        gameId: claims.gameId,
        playerId: claims.playerId,
        reason: "playerNotAllowed",
      });
      ws.close(4403, "player not allowed");
      return;
    }

    const game = await this.ensureGameForConnection(claims.gameId);
    if (!game) {
      await this.writeHistory({
        event: "connection.refused",
        gameId: claims.gameId,
        playerId: claims.playerId,
        reason: "gameNotAvailable",
      });
      ws.close(4503, "game not available");
      return;
    }

    const connectedAt = this.now();
    const sessionId = this.deps.ids?.generateSessionId() ?? generateSessionId();
    const session: BrokerSession = {
      sessionId,
      gameId: claims.gameId,
      playerId: claims.playerId,
      jwtClaims: claims,
      connectedAt,
      seq: 0,
      ws,
    };
    game.sessions.set(sessionId, session);
    this.clearSleepTimer(game);
    this.attachWebSocketHandlers(session);
    this.sendJson(ws, {
      type: "ready",
      sessionId,
      connectedAt: new Date(connectedAt).toISOString(),
      playerId: claims.playerId,
      gameId: claims.gameId,
    });
    await this.writeHistory({
      event: "session.opened",
      shardId: this.config.shardId,
      gameId: claims.gameId,
      playerId: claims.playerId,
      sessionId,
      connectedAt,
      traceId: stringOrNull(claims.traceId),
    });
    await this.invokeGameHandler(
      game,
      "onPlayerConnect",
      {
        playerId: claims.playerId,
        sessionId,
        jwtClaims: claims,
        connectedAt,
      },
      { sessionId, traceId: stringOrNull(claims.traceId) },
    );
  }

  async handleRunnerEnvelope(runnerId: string, envelope: RunnerToBrokerEnvelope): Promise<void> {
    if (envelope.type === RUNNER_TO_BROKER.runnerReady) {
      await this.writeHistory({
        event: "runner.ready",
        runnerId,
        kind: envelope.payload.kind,
        pid: envelope.payload.pid,
      });
      return;
    }
    if (envelope.type === RUNNER_TO_BROKER.runnerUnknownMessage) {
      await this.writeHistory({
        event: "runner.unknownMessage",
        runnerId,
        type: envelope.payload.type,
        detail: envelope.payload.detail,
      });
      return;
    }

    const game = this.validateAssignedRunner(runnerId, envelope.gameId, envelope.type);
    if (!game) return;

    switch (envelope.type) {
      case RUNNER_TO_BROKER.isolateReady:
        await this.writeHistory({
          event: "isolate.ready",
          gameId: game.gameId,
          runnerId,
          bundleName: envelope.payload.bundleName,
          bundleCompatTag: envelope.payload.bundleCompatTag,
        });
        return;
      case RUNNER_TO_BROKER.stateRead:
        await this.respond(game, "state.read.response", await this.readState(game, envelope.requestId), envelope.requestId);
        return;
      case RUNNER_TO_BROKER.stateWrite:
        await this.respond(game, "state.write.response", {
          response: await this.writeState(game, envelope.payload.value, envelope.requestId),
        }, envelope.requestId);
        return;
      case RUNNER_TO_BROKER.stateFlush:
        await this.respond(game, "state.flush.response", {
          response: await this.flushState(game, "state.flush", envelope.requestId),
        }, envelope.requestId);
        return;
      case RUNNER_TO_BROKER.blobPut:
        await this.respond(game, "blob.put.response", {
          response: await this.putBlob(game, envelope.payload, envelope.requestId),
        }, envelope.requestId);
        return;
      case RUNNER_TO_BROKER.blobGet:
        await this.respond(game, "blob.get.response", await this.getBlob(game, envelope.payload, envelope.requestId), envelope.requestId);
        return;
      case RUNNER_TO_BROKER.blobDelete:
        await this.respond(game, "blob.delete.response", await this.deleteBlob(game, envelope.payload.key, envelope.requestId), envelope.requestId);
        return;
      case RUNNER_TO_BROKER.blobList:
        await this.respond(game, "blob.list.response", await this.listBlobs(game, envelope.payload, envelope.requestId), envelope.requestId);
        return;
      case RUNNER_TO_BROKER.wsSend:
        await this.respond(game, "ws.send.response", {
          response: await this.handleWsSend(game, envelope.payload, envelope.requestId),
        }, envelope.requestId);
        return;
      case RUNNER_TO_BROKER.playersAllowed:
        await this.respond(game, "players.allowed.response", await this.playersAllowed(game, envelope.requestId), envelope.requestId);
        return;
      case RUNNER_TO_BROKER.playersConnected:
        await this.respond(game, "players.connected.response", await this.playersConnected(game, envelope.requestId), envelope.requestId);
        return;
      case RUNNER_TO_BROKER.computeBudget:
        await this.respond(game, "compute.budget.response", await this.computeBudget(game, envelope.requestId), envelope.requestId);
        return;
      case RUNNER_TO_BROKER.apiInvoke:
        await this.respond(game, "api.invoke.response", {
          response: await this.invokeGateway(game, envelope.payload, envelope.requestId),
        }, envelope.requestId);
        return;
      case RUNNER_TO_BROKER.logEmit:
        await this.writeHistory({
          event: "log.emit",
          gameId: game.gameId,
          runId: game.runId,
          bundleName: game.bundleName,
          bundleCompatTag: game.bundleCompatTag,
          payload: envelope.payload,
        });
        return;
      case RUNNER_TO_BROKER.metricsEmit:
        await this.writeHistory({ event: "metrics.emit", gameId: game.gameId, ...envelope.payload });
        return;
      case RUNNER_TO_BROKER.lifecycleRequestSleep:
        void this.sleepGame(game, "requestedBySleep");
        return;
      case RUNNER_TO_BROKER.lifecycleSleepComplete:
        await this.releaseGame(game, envelope.payload.reason);
        return;
      case RUNNER_TO_BROKER.handlerComplete:
        await this.writeHistory({
          event: "handler.complete",
          gameId: game.gameId,
          ...envelope.payload,
          handlerName: envelope.payload.handler,
        });
        return;
      case RUNNER_TO_BROKER.handlerError:
        await this.writeHistory({
          event: "handler.error",
          gameId: game.gameId,
          ...envelope.payload,
          handlerName: envelope.payload.handler,
        });
        if (envelope.payload.code === "handlerTimeout") {
          await this.writeHistory({
            event: "compute.budget.rejected",
            gameId: game.gameId,
            requestId: envelope.requestId,
            budget: "cpu-ms-per-tick",
            reason: "handlerTimeout",
            used: envelope.payload.durationMs,
            limit: envelope.payload.timeoutMs,
          });
        }
        return;
      case RUNNER_TO_BROKER.isolateFatal:
        await this.writeHistory({ event: "isolate.fatal", gameId: game.gameId, ...envelope.payload });
        await this.releaseGame(game, "shutdown");
        return;
      case RUNNER_TO_BROKER.isolateCounters:
        game.budgets.cpuMs = envelope.payload.cpuMs;
        game.budgets.memoryBytes = envelope.payload.memoryBytes;
        await this.writeHistory({ event: "isolate.counters", ...envelope.payload, gameId: game.gameId });
        return;
      case RUNNER_TO_BROKER.wsSendRejected:
        await this.writeHistory({ event: "ws.send.rejected", gameId: game.gameId, ...envelope.payload });
        return;
      default: {
        const _exhaustive: never = envelope;
        throw new Error(`unhandled runner envelope ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  async deliverQueuedHostEventsForGame(gameId: string): Promise<number> {
    this.ensureStarted();
    const game = this.games.get(gameId) ?? await this.ensureGameForConnection(gameId);
    if (!game) return 0;
    return await this.deliverQueuedHostEvents(game);
  }

  snapshotCapacity(): BrokerCapacityRow {
    const activeGames = this.games.size;
    const hardLimit = Math.floor(this.config.capacity.maxActiveGames * this.config.capacity.hardWatermarkPct);
    return {
      shardId: this.config.shardId,
      url: this.config.publicUrl,
      status: this.started ? "healthy" : "unhealthy",
      healthy: this.started,
      acceptingWakes: this.acceptingWakes && activeGames < hardLimit,
      runtimeContractsSupported: this.config.runtimeContractsSupported,
      activeGames,
      currentGameCount: activeGames,
      maxGames: this.config.capacity.maxActiveGames,
      lastSeenAt: this.now(),
    };
  }

  healthSnapshot(): BrokerHealthSnapshot {
    return {
      shardId: this.config.shardId,
      started: this.started,
      acceptingWakes: this.acceptingWakes,
      activeGames: this.games.size,
      connectedSessions: [...this.games.values()].reduce((total, game) => total + game.sessions.size, 0),
      capacity: this.snapshotCapacity(),
    };
  }

  metricsText(): string {
    const capacity = this.snapshotCapacity();
    const connectedSessions = [...this.games.values()].reduce((total, game) => total + game.sessions.size, 0);
    const budgetSnapshots = [...this.games.values()].map((game) => this.computeBudgetSnapshot(game));
    const lines = [
      "# HELP pax_broker_active_games Active games on this Broker.",
      "# TYPE pax_broker_active_games gauge",
      `pax_broker_active_games ${this.games.size}`,
      "# HELP pax_broker_connected_sessions Connected websocket sessions on this Broker.",
      "# TYPE pax_broker_connected_sessions gauge",
      `pax_broker_connected_sessions ${connectedSessions}`,
      "# HELP pax_broker_accepting_wakes Whether this Broker is accepting new wakes.",
      "# TYPE pax_broker_accepting_wakes gauge",
      `pax_broker_accepting_wakes ${capacity.acceptingWakes ? 1 : 0}`,
      "# HELP pax_broker_capacity_max_games Configured active-game capacity.",
      "# TYPE pax_broker_capacity_max_games gauge",
      `pax_broker_capacity_max_games ${capacity.maxGames}`,
      "# HELP pax_broker_budget_consumed_ratio Max current budget usage ratio by budget.",
      "# TYPE pax_broker_budget_consumed_ratio gauge",
      ...budgetRatioLines(budgetSnapshots),
      "",
    ];
    return lines.join("\n");
  }

  private async ensureGameForConnection(gameId: string): Promise<BrokerGame | undefined> {
    const existing = this.games.get(gameId);
    if (existing) return existing;
    const wake = await this.deps.bundles?.resolveForGame(gameId);
    if (!wake) return undefined;
    await this.wakeGame(wake);
    return this.games.get(gameId);
  }

  private async deliverQueuedHostEvents(game: BrokerGame): Promise<number> {
    const records = await this.deps.hostEvents?.drain(game.gameId) ?? [];
    for (const record of records) {
      await this.deliverHostEventRecord(game, record);
    }
    return records.length;
  }

  private async deliverHostEventRecord(game: BrokerGame, record: HostEventRecord): Promise<void> {
    await this.invokeGameHandler(game, "onHostEvent", {
      eventType: record.eventType,
      payload: record.payload,
      receivedAt: record.receivedAt,
      eventId: record.eventId,
      deliveryAttempts: record.deliveryAttempts,
    });
    await this.writeHistory({
      event: "onHostEvent.delivered",
      gameId: game.gameId,
      eventId: record.eventId,
      eventType: record.eventType,
      wakeOnDelivery: record.wakeOnDelivery,
      deliveryAttempts: record.deliveryAttempts,
    });
  }

  private attachWebSocketHandlers(session: BrokerSession): void {
    session.ws.on("message", (data) => {
      void this.handlePlayerMessage(session, data).catch((err) => {
        this.deps.logger?.warn({ err, sessionId: session.sessionId }, "player message failed");
      });
    });
    session.ws.on("close", () => {
      void this.handleSessionClosed(session, "left").catch((err) => {
        this.deps.logger?.warn({ err, sessionId: session.sessionId }, "session close failed");
      });
    });
  }

  private async handlePlayerMessage(session: BrokerSession, data: RawData): Promise<void> {
    const game = this.games.get(session.gameId);
    if (!game || !game.sessions.has(session.sessionId)) return;
    const text = rawDataToString(data);
    if (Buffer.byteLength(text, "utf8") > (this.config.maxInboundFrameBytes ?? 1024 * 1024)) {
      await this.writeHistory({
        event: "ws.recv.oversized",
        gameId: session.gameId,
        sessionId: session.sessionId,
        playerId: session.playerId,
      });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      await this.writeHistory({
        event: "ws.recv.malformed",
        gameId: session.gameId,
        sessionId: session.sessionId,
        playerId: session.playerId,
      });
      return;
    }
    const seq = session.seq;
    session.seq += 1;
    await this.writeHistory({
      event: "onPlayerMessage",
      gameId: session.gameId,
      sessionId: session.sessionId,
      playerId: session.playerId,
      seq,
      body,
    });
    await this.invokeGameHandler(
      game,
      "onPlayerMessage",
      {
        playerId: session.playerId,
        sessionId: session.sessionId,
        seq,
        body,
      },
      { sessionId: session.sessionId, traceId: stringOrNull(session.jwtClaims["traceId"]) },
    );
  }

  private async handleSessionClosed(session: BrokerSession, reason: OnSleepPayload["reason"] | "left"): Promise<void> {
    const game = this.games.get(session.gameId);
    if (!game || !game.sessions.delete(session.sessionId)) return;
    await this.writeHistory({
      event: "session.closed",
      gameId: session.gameId,
      sessionId: session.sessionId,
      playerId: session.playerId,
      connectedAt: session.connectedAt,
      disconnectedAt: this.now(),
      reason,
      traceId: stringOrNull(session.jwtClaims["traceId"]),
    });
    await this.invokeGameHandler(game, "onPlayerDisconnect", {
      playerId: session.playerId,
      sessionId: session.sessionId,
      reason,
    });
    if (game.sessions.size === 0) this.scheduleSleep(game);
  }

  private scheduleSleep(game: BrokerGame): void {
    this.clearSleepTimer(game);
    const delay = this.config.sleepGraceMs ?? 60_000;
    const deadline = this.now() + delay;
    void this.writeHistory({
      event: "lifecycle.sleepGrace.started",
      gameId: game.gameId,
      delayMs: delay,
      deadline,
    });
    game.sleepTimer = setTimeout(() => {
      game.sleepTimer = undefined;
      void this.writeHistory({
        event: "lifecycle.sleepGrace.expired",
        gameId: game.gameId,
        deadline,
      });
      void this.sleepGame(game, "idle");
    }, delay);
    game.sleepTimer.unref();
  }

  private clearSleepTimer(game: BrokerGame, cause = "cancelled"): void {
    if (!game.sleepTimer) return;
    clearTimeout(game.sleepTimer);
    game.sleepTimer = undefined;
    void this.writeHistory({
      event: "lifecycle.sleepGrace.cancelled",
      gameId: game.gameId,
      cause,
    });
  }

  private async sleepGame(game: BrokerGame, reason: OnSleepPayload["reason"]): Promise<void> {
    if (!this.games.has(game.gameId)) return;
    this.clearSleepTimer(game, reason);
    const deadline = this.now() + (this.config.sleepDeadlineMs ?? 30_000);
    await this.writeHistory({
      event: "onSleep.sent",
      gameId: game.gameId,
      reason,
      deadline,
      budgetMs: this.config.sleepDeadlineMs ?? 30_000,
    });
    await this.invokeGameHandler(game, "onSleep", { reason, deadline });
    await this.releaseGame(game, reason);
  }

  private async releaseGame(game: BrokerGame, reason: string): Promise<void> {
    if (!this.games.delete(game.gameId)) return;
    this.clearSleepTimer(game, reason);
    this.closeSessions(game, reason);
    const response = await this.flushState(game, "state.flush.plannedTransition");
    await game.runner.release(game.gameId);
    await this.deps.directory.releaseActiveGame?.(game.gameId, game.generation);
    await this.writeHistory({
      event: "game.released",
      gameId: game.gameId,
      runnerId: game.runner.id,
      reason,
      checkpointOk: response.ok,
    });
    await this.publishCapacity();
  }

  private closeSessions(game: BrokerGame, reason: string): void {
    for (const session of game.sessions.values()) {
      this.sendJson(session.ws, {
        type: "disconnect",
        sessionId: session.sessionId,
        reason,
      });
      session.ws.close(1001, reason);
    }
    game.sessions.clear();
  }

  private async invokeGameHandler(
    game: BrokerGame,
    handler: RuntimeHandlerName,
    payload: unknown,
    context: DispatchContext = { sessionId: null, traceId: null },
  ): Promise<void> {
    const previous = game.currentDispatch;
    game.currentDispatch = context;
    try {
      await game.runner.invoke({
        gameId: game.gameId,
        handler,
        payload,
        timeoutMs: this.config.handlerTimeoutMs ?? this.budgetLimits.cpuMsPerTick,
        traceId: context.traceId ?? undefined,
      });
    } finally {
      game.currentDispatch = previous;
    }
  }

  private validateAssignedRunner(runnerId: string, gameId: string, type: string): BrokerGame | undefined {
    const game = this.games.get(gameId);
    if (!game || game.runner.id !== runnerId) {
      void this.writeHistory({
        event: "runner.assignmentRejected",
        runnerId,
        gameId,
        type,
      });
      return undefined;
    }
    return game;
  }

  private async respond<T extends BrokerToRunnerEnvelope["type"]>(
    game: BrokerGame,
    type: T,
    payload: Extract<BrokerToRunnerEnvelope, { type: T }>["payload"],
    requestId?: string,
  ): Promise<void> {
    if (!requestId) return;
    await game.runner.send(
      bridgeEnvelope(game.gameId, type, payload, { requestId }) as BrokerToRunnerEnvelope,
    );
  }

  private async readState(
    game: BrokerGame,
    requestId?: string,
  ): Promise<{ readonly found: boolean; readonly value: unknown | null; readonly bytes: number }> {
    const bytes = game.state.readState();
    await this.writeHistory({
      event: "state.read",
      gameId: game.gameId,
      requestId,
      found: bytes.byteLength > 0,
      byteSize: bytes.byteLength,
    });
    return {
      found: bytes.byteLength > 0,
      value: decodeJsonState(bytes),
      bytes: bytes.byteLength,
    };
  }

  private async writeState(game: BrokerGame, value: unknown, requestId?: string): Promise<StorageWriteResponse> {
    const encoded = encodeJsonState(value);
    if (!encoded.ok) {
      const response = encoded.response;
      await this.writeHistory({
        event: "state.write.rejected",
        gameId: game.gameId,
        requestId,
        error: response.ok ? "storageUnavailable" : response.error,
      });
      return response;
    }
    if (encoded.bytes.byteLength > this.budgetLimits.stateBytes) {
      await this.writeHistory({
        event: "state.write.rejected",
        gameId: game.gameId,
        requestId,
        error: "sizeExceeded",
        limit: this.budgetLimits.stateBytes,
      });
      return { ok: false, error: "sizeExceeded", detail: { limit: this.budgetLimits.stateBytes } };
    }
    game.state.writeState(encoded.bytes);
    game.budgets.stateBytes = encoded.bytes.byteLength;
    await this.writeHistory({
      event: "state.write",
      gameId: game.gameId,
      requestId,
      byteSize: encoded.bytes.byteLength,
    });
    return { ok: true };
  }

  private async flushState(game: BrokerGame, event: string, requestId?: string): Promise<StorageWriteResponse> {
    try {
      const root = await game.state.flush();
      await this.writeHistory({
        event,
        gameId: game.gameId,
        requestId,
        checkpointSeq: root?.checkpointSeq,
      });
      return { ok: true };
    } catch (err) {
      await this.writeHistory({
        event: "storage.unavailable",
        gameId: game.gameId,
        operation: event,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: "storageUnavailable" };
    }
  }

  private async putBlob(game: BrokerGame, payload: BlobPutIpcPayload, requestId?: string): Promise<StorageWriteResponse> {
    const keyCheck = validateBlobKey(payload.key);
    if (!keyCheck.ok) {
      await this.writeHistory({
        event: "blob.put.rejected",
        gameId: game.gameId,
        requestId,
        key: payload.key,
        error: keyCheck.error,
      });
      return keyCheck;
    }
    const bytes = Buffer.from(payload.bytesBase64, "base64");
    const previousSize = game.blobSizes.get(payload.key) ?? 0;
    const nextBlobBytes = game.budgets.blobBytes - previousSize + bytes.byteLength;
    const nextBlobKeys = game.blobSizes.has(payload.key) ? game.budgets.blobKeys : game.budgets.blobKeys + 1;
    if (nextBlobBytes > this.budgetLimits.blobBytes) {
      await this.writeHistory({
        event: "blob.put.rejected",
        gameId: game.gameId,
        requestId,
        key: payload.key,
        error: "sizeExceeded",
        limit: this.budgetLimits.blobBytes,
      });
      return { ok: false, error: "sizeExceeded", detail: { limit: this.budgetLimits.blobBytes } };
    }
    if (nextBlobKeys > this.budgetLimits.blobKeys) {
      await this.writeHistory({
        event: "blob.put.rejected",
        gameId: game.gameId,
        requestId,
        key: payload.key,
        error: "keyCountExceeded",
        limit: this.budgetLimits.blobKeys,
      });
      return { ok: false, error: "keyCountExceeded", detail: { limit: this.budgetLimits.blobKeys } };
    }
    await game.state.putBlob(payload.key, bytes);
    game.blobSizes.set(payload.key, bytes.byteLength);
    game.budgets.blobBytes = nextBlobBytes;
    game.budgets.blobKeys = nextBlobKeys;
    await this.writeHistory({
      event: "blob.put",
      gameId: game.gameId,
      requestId,
      key: payload.key,
      byteSize: bytes.byteLength,
    });
    return { ok: true };
  }

  private async getBlob(
    game: BrokerGame,
    payload: BlobGetIpcPayload,
    requestId?: string,
  ): Promise<{ readonly found: boolean; readonly bytesBase64?: string; readonly bytes: number }> {
    const bytes = await game.state.getBlob(payload.key);
    await this.writeHistory({
      event: "blob.get",
      gameId: game.gameId,
      requestId,
      key: payload.key,
      found: bytes !== undefined,
      byteSize: bytes?.byteLength ?? 0,
    });
    return bytes
      ? { found: true, bytesBase64: Buffer.from(bytes).toString("base64"), bytes: bytes.byteLength }
      : { found: false, bytes: 0 };
  }

  private async deleteBlob(game: BrokerGame, key: string, requestId?: string): Promise<{ readonly ok: true }> {
    const previousSize = game.blobSizes.get(key);
    await game.state.deleteBlob(key);
    if (previousSize !== undefined) {
      game.blobSizes.delete(key);
      game.budgets.blobBytes = Math.max(0, game.budgets.blobBytes - previousSize);
      game.budgets.blobKeys = game.blobSizes.size;
    }
    await this.writeHistory({ event: "blob.delete", gameId: game.gameId, requestId, key });
    return { ok: true };
  }

  private async listBlobs(
    game: BrokerGame,
    payload: BlobListIpcPayload,
    requestId?: string,
  ): Promise<{ readonly items: readonly { readonly key: string; readonly size: number }[] }> {
    const keys = await game.state.listBlobs(payload.prefix);
    const items = keys.map((key) => ({ key, size: game.blobSizes.get(key) ?? 0 }));
    await this.writeHistory({
      event: "blob.list",
      gameId: game.gameId,
      requestId,
      prefix: payload.prefix,
      keyCount: items.length,
    });
    return {
      items,
    };
  }

  private async handleWsSend(game: BrokerGame, payload: WsSendPayload, requestId?: string): Promise<WsSendResponse> {
    const serialized = trySerializeWsBody(payload.body);
    if (!serialized.ok) {
      const response = serialized.response;
      await this.writeHistory({
        event: "ws.send.rejected",
        gameId: game.gameId,
        requestId,
        target: payload.target,
        error: response.ok ? "serializationFailed" : response.error,
      });
      return response;
    }
    const targets = resolveWsSendTargets(payload.target, [...game.sessions.values()]);
    if (!targets.ok) {
      const response = targets.response;
      await this.writeHistory({
        event: "ws.send.rejected",
        gameId: game.gameId,
        requestId,
        target: payload.target,
        error: response.ok ? "targetInvalid" : response.error,
      });
      return response;
    }

    const frames = targets.sessions.map((session) => ({
      session,
      serialized: JSON.stringify(wsFrameForSend(payload.body, session.sessionId)),
    }));
    const bytes = frames.reduce(
      (total, frame) => total + Buffer.byteLength(frame.serialized, "utf8"),
      0,
    );
    const now = this.now();
    if (game.budgets.wsBytes.sum(now) + bytes > this.budgetLimits.bandwidthBytesPerSec) {
      await this.writeHistory({
        event: "ws.send.rejected",
        gameId: game.gameId,
        requestId,
        target: payload.target,
        error: "bandwidthExceeded",
        limit: this.budgetLimits.bandwidthBytesPerSec,
      });
      return { ok: false, error: "bandwidthExceeded", detail: { limit: this.budgetLimits.bandwidthBytesPerSec } };
    }
    if (game.budgets.wsMessages.sum(now) + 1 > this.budgetLimits.wsMessagesPerSec) {
      await this.writeHistory({
        event: "ws.send.rejected",
        gameId: game.gameId,
        requestId,
        target: payload.target,
        error: "rateExceeded",
        limit: this.budgetLimits.wsMessagesPerSec,
      });
      return { ok: false, error: "rateExceeded", detail: { limit: this.budgetLimits.wsMessagesPerSec } };
    }
    game.budgets.wsBytes.add(bytes, now);
    game.budgets.wsMessages.add(1, now);

    let sent = 0;
    const sentSessions: BrokerSession[] = [];
    for (const { session, serialized: frame } of frames) {
      if (session.ws.readyState !== WebSocket.OPEN) continue;
      session.ws.send(frame);
      sentSessions.push(session);
      sent += 1;
    }
    const singleRecipient =
      sentSessions.length === 1
        ? { sessionId: sentSessions[0]!.sessionId, playerId: sentSessions[0]!.playerId }
        : {};
    await this.writeHistory({
      event: "ws.send",
      gameId: game.gameId,
      requestId,
      target: payload.target,
      recipientCount: sent,
      bytes,
      ...singleRecipient,
    });
    return { ok: true, sent, bytes };
  }

  private async playersAllowed(
    game: BrokerGame,
    requestId?: string,
  ): Promise<{ readonly players: readonly string[] }> {
    const players = await this.deps.allowedPlayers.list(game.gameId);
    await this.writeHistory({
      event: "players.allowed",
      gameId: game.gameId,
      requestId,
      playerCount: players.length,
    });
    return { players };
  }

  private async playersConnected(
    game: BrokerGame,
    requestId?: string,
  ): Promise<{ readonly players: readonly ConnectedSessionSnapshot[] }> {
    const players = this.connectedSessions(game);
    await this.writeHistory({
      event: "players.connected",
      gameId: game.gameId,
      requestId,
      playerCount: players.length,
    });
    return { players };
  }

  private async computeBudget(
    game: BrokerGame,
    requestId?: string,
  ): Promise<{ readonly budget: ComputeBudgetSnapshot }> {
    const budget = this.computeBudgetSnapshot(game);
    await this.writeHistory({
      event: "compute.budget",
      gameId: game.gameId,
      requestId,
      snapshot: budget,
    });
    return { budget };
  }

  private async invokeGateway(
    game: BrokerGame,
    payload: ApiInvokeRequest,
    requestId?: string,
  ): Promise<ApiInvokeResponse> {
    const now = this.now();
    game.budgets.apiInvocations.add(1, now);
    if (game.budgets.apiInvocations.sum(now) > this.budgetLimits.apiInvocationsPerMin) {
      await this.writeHistory({
        event: "compute.budget.rejected",
        gameId: game.gameId,
        requestId,
        budget: "api-invocations-per-min",
        used: game.budgets.apiInvocations.sum(now),
        limit: this.budgetLimits.apiInvocationsPerMin,
      });
      await this.writeHistory({
        event: "api.invoke.response",
        gameId: game.gameId,
        requestId,
        kind: payload.kind,
        traceId: game.currentDispatch?.traceId ?? null,
        ok: false,
        error: "apiRateExceeded",
        durationMs: 0,
      });
      return { ok: false, error: "apiRateExceeded" };
    }
    const triggeringSession =
      game.currentDispatch?.sessionId ? game.sessions.get(game.currentDispatch.sessionId) : undefined;
    const traceId = game.currentDispatch?.traceId ?? null;
    const started = this.now();
    await this.writeHistory({
      event: "api.invoke.request",
      gameId: game.gameId,
      requestId,
      kind: payload.kind,
      triggeringSessionId: triggeringSession?.sessionId ?? null,
      traceId,
      connectedSessionCount: game.sessions.size,
      idempotencyKey: payload.idempotencyKey,
    });
    try {
      const result = await this.deps.gateway.invoke({
        ...payload,
        gameId: game.gameId,
        triggeringSessionId: triggeringSession?.sessionId ?? null,
        triggeringJwtClaims: triggeringSession?.jwtClaims ?? null,
        connectedSessions: this.connectedSessions(game),
        bundleName: game.bundleName,
        bundleCompatTag: game.bundleCompatTag,
        runId: game.runId,
        traceId,
      });
      if (result.wireRecord) {
        await this.writeHistory({
          event: "api.invoke.wire",
          gameId: game.gameId,
          requestId,
          kind: payload.kind,
          gatewayRequestId: result.wireRecord.requestId,
          runId: game.runId,
          traceId,
          fingerprint: result.wireRecord.fingerprint,
          mode: result.wireRecord.mode,
          statusCode: result.wireRecord.statusCode,
          error: result.wireRecord.error,
          rawOutbound: result.wireRecord.rawOutbound,
          rawInbound: result.wireRecord.rawInbound,
          recordedAt: result.wireRecord.recordedAt,
        });
      }
      await this.writeHistory({
        event: "api.invoke.response",
        gameId: game.gameId,
        requestId,
        kind: payload.kind,
        traceId,
        ok: result.response.ok,
        error: result.response.ok ? undefined : result.response.error,
        fingerprint: result.wireRecord?.fingerprint,
        mode: result.wireRecord?.mode,
        statusCode: result.wireRecord?.statusCode,
        durationMs: this.now() - started,
      });
      return result.response;
    } catch (err) {
      await this.writeHistory({
        event: "api.invoke.response",
        gameId: game.gameId,
        requestId,
        kind: payload.kind,
        traceId,
        ok: false,
        error: "providerError",
        durationMs: this.now() - started,
      });
      await this.writeHistory({
        event: "api.invoke.error",
        gameId: game.gameId,
        requestId,
        kind: payload.kind,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: "providerError" };
    }
  }

  private connectedSessions(game: BrokerGame): readonly ConnectedSessionSnapshot[] {
    return [...game.sessions.values()].map((session) => ({
      sessionId: session.sessionId,
      playerId: session.playerId,
      connectedAt: session.connectedAt,
    }));
  }

  private computeBudgetSnapshot(game: BrokerGame): ComputeBudgetSnapshot {
    const now = this.now();
    return {
      "cpu-ms-per-tick": {
        currentUsage: game.budgets.cpuMs,
        limit: this.budgetLimits.cpuMsPerTick,
      },
      "memory-bytes": {
        currentUsage: game.budgets.memoryBytes,
        limit: this.budgetLimits.memoryBytes,
      },
      "bandwidth-bytes-per-sec": {
        currentUsage: game.budgets.wsBytes.sum(now),
        limit: this.budgetLimits.bandwidthBytesPerSec,
        windowMs: 1_000,
      },
      "ws-messages-per-sec": {
        currentUsage: game.budgets.wsMessages.sum(now),
        limit: this.budgetLimits.wsMessagesPerSec,
        windowMs: 1_000,
      },
      "state-bytes": {
        currentUsage: game.budgets.stateBytes,
        limit: this.budgetLimits.stateBytes,
      },
      "blob-bytes": {
        currentUsage: game.budgets.blobBytes,
        limit: this.budgetLimits.blobBytes,
      },
      "blob-keys": {
        currentUsage: game.budgets.blobKeys,
        limit: this.budgetLimits.blobKeys,
      },
      "api-invocations-per-min": {
        currentUsage: game.budgets.apiInvocations.sum(now),
        limit: this.budgetLimits.apiInvocationsPerMin,
        windowMs: 60_000,
      },
    };
  }

  private async materializeBlobSizes(state: GameStateSession): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    for (const key of await state.listBlobs()) {
      const bytes = await state.getBlob(key);
      sizes.set(key, bytes?.byteLength ?? 0);
    }
    return sizes;
  }

  private verifyPlacementToken(token: string): VerifiedPlacementClaims {
    const decoded = jwt.verify(token, this.config.jwtSecret, { algorithms: ["HS256"] });
    if (!decoded || typeof decoded !== "object") throw new Error("placement token payload is not an object");
    const claims = decoded as PlacementClaims;
    if (typeof claims.gameId !== "string") throw new Error("placement token missing gameId");
    if (typeof claims.playerId !== "string") throw new Error("placement token missing playerId");
    if (typeof claims.shardId !== "string") throw new Error("placement token missing shardId");
    return {
      ...claims,
      gameId: claims.gameId,
      playerId: claims.playerId,
      shardId: claims.shardId,
    } as VerifiedPlacementClaims;
  }

  private ensureRuntimeContract(required: number): void {
    const [min, max] = this.config.runtimeContractsSupported;
    if (required < min || required > max) {
      throw new Error(`runtime contract ${required} outside shard range [${min}, ${max}]`);
    }
  }

  private ensureCapacity(): void {
    if (!this.acceptingWakes) throw new Error("broker is not accepting wakes");
    if (this.games.size >= this.config.capacity.maxActiveGames) {
      throw new Error("broker capacity exhausted");
    }
  }

  private sendJson(ws: WebSocket, value: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(value));
  }

  private async publishCapacity(): Promise<void> {
    await this.deps.directory.publishCapacity(this.snapshotCapacity());
  }

  private startCapacityHeartbeat(): void {
    this.stopCapacityHeartbeat();
    const intervalMs = this.config.capacityHeartbeatMs ?? 10_000;
    this.capacityHeartbeat = setInterval(() => {
      void this.publishCapacity().catch((err) => {
        this.deps.logger?.warn({ err }, "capacity heartbeat failed");
      });
    }, intervalMs);
    this.capacityHeartbeat.unref();
  }

  private stopCapacityHeartbeat(): void {
    if (!this.capacityHeartbeat) return;
    clearInterval(this.capacityHeartbeat);
    this.capacityHeartbeat = undefined;
  }

  private async writeHistory(event: Record<string, unknown>): Promise<void> {
    await this.deps.history.write({
      ts: new Date(this.now()).toISOString(),
      shardId: this.config.shardId,
      ...event,
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private ensureStarted(): void {
    if (!this.started) throw new Error("broker is not started");
  }
}

export function createBrokerAdminServer(broker: Broker): Server {
  return createServer((req, res) => {
    void handleBrokerAdminRequest(broker, req, res).catch((err) => {
      writeJson(res, 500, {
        error: "brokerAdminError",
        detail: { message: err instanceof Error ? err.message : String(err) },
      });
    });
  });
}

async function handleBrokerAdminRequest(
  broker: Broker,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://broker.internal");
  if (method === "GET" && url.pathname === "/healthz") {
    writeJson(res, 200, broker.healthSnapshot());
    return;
  }
  if (method === "GET" && url.pathname === "/readyz") {
    const health = broker.healthSnapshot();
    writeJson(res, health.started && health.acceptingWakes ? 200 : 503, health);
    return;
  }
  if (method === "GET" && url.pathname === "/metrics") {
    writeText(res, 200, broker.metricsText(), "text/plain; version=0.0.4; charset=utf-8");
    return;
  }
  if (method === "POST" && url.pathname === "/admin/drain") {
    await broker.requestDrain("admin-http");
    writeJson(res, 202, broker.healthSnapshot());
    return;
  }
  if (method === "DELETE" && url.pathname === "/admin/drain") {
    await broker.resumeWakes("admin-http");
    writeJson(res, 200, broker.healthSnapshot());
    return;
  }
  const hostEventsDrainMatch = /^\/admin\/games\/([^/]+)\/host-events\/drain$/.exec(url.pathname);
  if (method === "POST" && hostEventsDrainMatch) {
    const delivered = await broker.deliverQueuedHostEventsForGame(decodeURIComponent(hostEventsDrainMatch[1]!));
    writeJson(res, 202, { ok: true, delivered });
    return;
  }
  const evictMatch = /^\/admin\/games\/([^/]+)\/evict$/.exec(url.pathname);
  if (method === "POST" && evictMatch) {
    const evicted = await broker.evictGame(decodeURIComponent(evictMatch[1]!));
    writeJson(res, evicted ? 202 : 404, evicted ? { ok: true } : { error: "gameNotFound" });
    return;
  }
  writeJson(res, 404, { error: "notFound" });
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  writeText(res, statusCode, `${JSON.stringify(body)}\n`, "application/json; charset=utf-8");
}

function writeText(res: ServerResponse, statusCode: number, body: string, contentType: string): void {
  res.writeHead(statusCode, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  res.end(body);
}

function budgetRatioLines(snapshots: readonly ComputeBudgetSnapshot[]): readonly string[] {
  const maxRatioByBudget = new Map<string, number>();
  for (const snapshot of snapshots) {
    for (const [budget, usage] of Object.entries(snapshot)) {
      const ratio = usage.limit > 0 ? usage.currentUsage / usage.limit : 0;
      maxRatioByBudget.set(budget, Math.max(maxRatioByBudget.get(budget) ?? 0, ratio));
    }
  }
  return [...maxRatioByBudget.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([budget, ratio]) => `pax_broker_budget_consumed_ratio{budget="${escapePromLabel(budget)}"} ${ratio}`);
}

function escapePromLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

class SlidingWindowCounter {
  private readonly samples: { readonly at: number; readonly value: number }[] = [];

  constructor(private readonly windowMs: number) {}

  add(value: number, at: number): void {
    this.prune(at);
    this.samples.push({ at, value });
  }

  sum(at: number): number {
    this.prune(at);
    return this.samples.reduce((total, sample) => total + sample.value, 0);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.samples.length > 0 && this.samples[0]!.at < cutoff) this.samples.shift();
  }
}

function encodeJsonState(
  value: unknown,
): { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly response: StorageWriteResponse } {
  try {
    const json = JSON.stringify(value);
    if (typeof json !== "string") {
      return {
        ok: false,
        response: { ok: false, error: "storageUnavailable", detail: { message: "state must be JSON-serializable" } },
      };
    }
    return { ok: true, bytes: Buffer.from(json, "utf8") };
  } catch (err) {
    return {
      ok: false,
      response: {
        ok: false,
        error: "storageUnavailable",
        detail: { message: err instanceof Error ? err.message : String(err) },
      },
    };
  }
}

function decodeJsonState(bytes: Uint8Array): unknown | null {
  if (bytes.byteLength === 0) return null;
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
}

function validateBlobKey(key: string): StorageWriteResponse {
  if (key.length === 0) {
    return { ok: false, error: "storageUnavailable", detail: { message: "blob key is empty" } };
  }
  if (Buffer.byteLength(key, "utf8") > 256) {
    return { ok: false, error: "storageUnavailable", detail: { message: "blob key exceeds 256 bytes" } };
  }
  return { ok: true };
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

function trySerializeWsBody(
  body: unknown,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly response: WsSendResponse } {
  try {
    const text = JSON.stringify(body);
    if (typeof text !== "string") {
      return {
        ok: false,
        response: { ok: false, error: "serializationFailed", detail: { message: "body is not JSON-serializable" } },
      };
    }
    return { ok: true, text };
  } catch (err) {
    return {
      ok: false,
      response: {
        ok: false,
        error: "serializationFailed",
        detail: { message: err instanceof Error ? err.message : String(err) },
      },
    };
  }
}

function wsFrameForSend(body: unknown, sessionId: string): unknown {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return { ...(body as Record<string, unknown>), sessionId };
  }
  return {
    type: "message",
    sessionId,
    body,
  };
}

type WsTargetResolution =
  | { readonly ok: true; readonly sessions: readonly BrokerSession[] }
  | { readonly ok: false; readonly response: WsSendResponse };

function resolveWsSendTargets(target: WsTarget, sessions: readonly BrokerSession[]): WsTargetResolution {
  if (target === "all") return { ok: true, sessions };
  if (typeof target === "string") {
    const matched = sessions.filter((session) => session.playerId === target);
    return matched.length > 0
      ? { ok: true, sessions: matched }
      : { ok: false, response: { ok: false, error: "targetNotConnected", detail: { target } } };
  }
  if (!Array.isArray(target)) {
    return { ok: false, response: { ok: false, error: "targetInvalid" } };
  }
  const requested = new Set(target);
  const missing = [...requested].filter((playerId) => !sessions.some((session) => session.playerId === playerId));
  if (missing.length > 0) {
    return {
      ok: false,
      response: { ok: false, error: "targetNotConnected", detail: { missing, missingTargets: missing } },
    };
  }
  return {
    ok: true,
    sessions: sessions.filter((session) => requested.has(session.playerId)),
  };
}

function sumMapValues(values: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const value of values.values()) total += value;
  return total;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export * from "./adapters.mjs";
