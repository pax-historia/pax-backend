import { defineBundle } from "@pax-backend/runtime-sdk";

const connectedPlayers = new Set<string>();

export default defineBundle({
  manifest: {
    compatTagProduced: "smoke:v1",
    compatTagsAccepted: ["smoke:v1"],
    runtimeContractRequired: 1,
  },

  onWake(c, payload) {
    c.log.emit({ event: "hello-ai-call.onWake", payload });
  },

  onPlayerConnect(c, payload) {
    connectedPlayers.add(payload.playerId);
    c.log.emit({
      event: "hello-ai-call.onPlayerConnect",
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      connectedCount: connectedPlayers.size,
    });
    c.ws.send(payload.playerId, {
      type: "ready",
      bundle: "hello-ai-call",
      sessionId: payload.sessionId,
    });
  },

  async onPlayerMessage(c, payload) {
    const response = await c.api.invoke(
      "mock-ai.v1",
      {
        messages: [
          {
            role: "user",
            content: JSON.stringify(payload.body),
          },
        ],
        playerId: payload.playerId,
        sessionId: payload.sessionId,
        seq: payload.seq,
      },
      { idempotencyKey: `${payload.sessionId}:${payload.seq}:mock-ai.v1` },
    );

    c.log.emit({
      event: "hello-ai-call.apiResult",
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      seq: payload.seq,
      ok: response.ok,
      error: response.ok ? undefined : response.error,
    });

    c.ws.send(payload.playerId, {
      type: "mock-ai.v1",
      sessionId: payload.sessionId,
      seq: payload.seq,
      response,
    });
  },

  onPlayerDisconnect(c, payload) {
    connectedPlayers.delete(payload.playerId);
    c.log.emit({
      event: "hello-ai-call.onPlayerDisconnect",
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      connectedCount: connectedPlayers.size,
    });
  },
});
