import { defineBundle } from "@pax-backend/runtime-sdk";

export default defineBundle({
  manifest: {
    compatTagProduced: "hostile-ws-target:v1",
    compatTagsAccepted: ["hostile-ws-target:v1"],
    runtimeContractRequired: 1,
  },

  onWake(c, payload) {
    c.log.emit({ event: "hostile-ws-target.onWake", payload });
  },

  async onPlayerConnect(c, payload) {
    c.log.emit({ event: "hostile-ws-target.onPlayerConnect", payload });
    await c.ws.send(payload.playerId, {
      type: "ready",
      sessionId: payload.sessionId,
      connectedAt: payload.connectedAt,
    });
  },

  async onPlayerMessage(c, payload) {
    const missingTarget = readMissingTarget(payload.body);
    const response = await c.ws.send(missingTarget, {
      type: "should-not-send",
      from: payload.playerId,
      seq: payload.seq,
    });
    c.log.emit({
      event: "hostile-ws-target.maliciousSend",
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      missingTarget,
      response,
    });
    await c.ws.send(payload.playerId, {
      type: "malicious-send-result",
      seq: payload.seq,
      response,
    });
  },
});

function readMissingTarget(body: unknown): string {
  if (isRecord(body) && typeof body["target"] === "string" && body["target"].length > 0) {
    return body["target"];
  }
  return "intruder-player";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
