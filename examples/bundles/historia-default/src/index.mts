import { defineBundle, type SubstrateContext } from "@pax-backend/runtime-sdk";

import { manifest } from "../manifest.js";
import { createGameContext, type HistoriaGameContext } from "./context.mjs";
import {
  commitSnapshot,
  loadHistoriaState,
  persistWorkingState,
  type LoadedHistoriaState,
} from "./core/persistence.mjs";

interface SessionSummary {
  readonly playerId: string;
  readonly connectedAt: number;
}

const sessions = new Map<string, SessionSummary>();
let loadedState: LoadedHistoriaState | undefined;
let gameContext: HistoriaGameContext | undefined;

export default defineBundle({
  manifest,

  async onWake(c, payload) {
    loadedState = await loadHistoriaState(c, payload);
    gameContext = createGameContext(c, loadedState);
    const persistResult = await persistWorkingState(c, loadedState.workingState);
    c.log.emit({
      event: "historia-default.onWake",
      reason: payload.reason,
      bundleName: payload.bundleName,
      runId: payload.runId,
      compatTagProduced: manifest.compatTagProduced,
      compatTagsAccepted: manifest.compatTagsAccepted,
      blobCompatTag: payload.blobCompatTag ?? null,
      migratedFrom: loadedState.migratedFrom ?? null,
      stateWrite: persistResult.stateWrite,
    });
  },

  async onPlayerConnect(c, payload) {
    sessions.set(payload.sessionId, {
      playerId: payload.playerId,
      connectedAt: payload.connectedAt,
    });

    c.metrics.emit({
      name: "historia_default.connected_sessions",
      kind: "gauge",
      value: sessions.size,
    });
    c.log.emit({
      event: "historia-default.onPlayerConnect",
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      connectedAt: payload.connectedAt,
      connectedPlayers: connectedPlayerCount(),
    });
    await c.ws.send(payload.playerId, {
      type: "historia.ready",
      bundle: "historia-default",
      sessionId: payload.sessionId,
      compatTag: manifest.compatTagProduced,
      connectedPlayers: connectedPlayerCount(),
      snapshot: hydrationSummary(),
    });
  },

  async onPlayerMessage(c, payload) {
    const ctx = requireGameContext(c);
    const messageType = readMessageType(payload.body);
    c.log.emit({
      event: "historia-default.onPlayerMessage",
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      seq: payload.seq,
      messageType,
      currentRound: ctx.loaded.blob.game.currentRound,
    });
    await c.ws.send(payload.playerId, {
      type: "historia.unhandled",
      seq: payload.seq,
      messageType,
      currentRound: ctx.loaded.blob.game.currentRound,
    });
  },

  onPlayerDisconnect(c, payload) {
    sessions.delete(payload.sessionId);
    c.metrics.emit({
      name: "historia_default.connected_sessions",
      kind: "gauge",
      value: sessions.size,
    });
    c.log.emit({
      event: "historia-default.onPlayerDisconnect",
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      reason: payload.reason,
      connectedPlayers: connectedPlayerCount(),
    });
  },

  async onSleep(c, payload) {
    const commitResult = loadedState
      ? await commitSnapshot(c, loadedState.blob)
      : undefined;
    c.log.emit({
      event: "historia-default.onSleep",
      reason: payload.reason,
      deadline: payload.deadline,
      connectedSessions: sessions.size,
      connectedPlayers: connectedPlayerCount(),
      commitResult,
    });
  },

  onCapacityWarning(c, payload) {
    c.metrics.emit({
      name: "historia_default.capacity_warning",
      kind: "counter",
      value: 1,
      tags: { budget: payload.budget },
    });
    c.log.emit({
      event: "historia-default.onCapacityWarning",
      payload,
    });
  },

  async onHostEvent(c, payload) {
    c.log.emit({
      event: "historia-default.onHostEvent",
      eventId: payload.eventId,
      eventType: payload.eventType,
      deliveryAttempts: payload.deliveryAttempts,
      receivedAt: payload.receivedAt,
    });
    await c.ws.send("all", {
      type: "historia.hostEvent",
      eventId: payload.eventId,
      eventType: payload.eventType,
      payload: payload.payload,
    });
  },
});

function connectedPlayerCount(): number {
  return new Set([...sessions.values()].map((session) => session.playerId)).size;
}

function requireGameContext(c: SubstrateContext): HistoriaGameContext {
  if (gameContext) return gameContext;
  const now = c.now();
  throw new Error(`historia-default missing game context at ${now}`);
}

function hydrationSummary(): Readonly<Record<string, unknown>> {
  if (!loadedState) return { status: "not-loaded" };
  return {
    status: loadedState.blob.game.status,
    title: loadedState.blob.game.title ?? null,
    currentRound: loadedState.blob.game.currentRound,
    players: Object.keys(loadedState.blob.game.players).length,
    pendingEvents: loadedState.workingState.currentRoundDeltas.length,
    migratedFrom: loadedState.migratedFrom ?? null,
  };
}

function readMessageType(body: unknown): string {
  if (!isRecord(body)) return "unknown";
  const type = body["type"];
  return typeof type === "string" && type.length > 0 ? type : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
