import { defineBundle } from "@pax-backend/runtime-sdk";

import { manifest } from "../manifest.js";

interface SessionSummary {
  readonly playerId: string;
  readonly connectedAt: number;
}

const sessions = new Map<string, SessionSummary>();

export default defineBundle({
  manifest,

  onWake(c, payload) {
    c.log.emit({
      event: "historia-default.onWake",
      reason: payload.reason,
      bundleName: payload.bundleName,
      runId: payload.runId,
      compatTagProduced: manifest.compatTagProduced,
      compatTagsAccepted: manifest.compatTagsAccepted,
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
    });
  },

  async onPlayerMessage(c, payload) {
    const messageType = readMessageType(payload.body);
    c.log.emit({
      event: "historia-default.onPlayerMessage",
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      seq: payload.seq,
      messageType,
    });
    await c.ws.send(payload.playerId, {
      type: "historia.unhandled",
      seq: payload.seq,
      messageType,
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

  onSleep(c, payload) {
    c.log.emit({
      event: "historia-default.onSleep",
      reason: payload.reason,
      deadline: payload.deadline,
      connectedSessions: sessions.size,
      connectedPlayers: connectedPlayerCount(),
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

function readMessageType(body: unknown): string {
  if (!isRecord(body)) return "unknown";
  const type = body["type"];
  return typeof type === "string" && type.length > 0 ? type : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
