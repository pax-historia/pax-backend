import { defineBundle, type SubstrateContext } from "@pax-backend/runtime-sdk";

export default defineBundle({
  manifest: {
    compatTagProduced: "budget-edge-probe:v1",
    compatTagsAccepted: ["budget-edge-probe:v1"],
    runtimeContractRequired: 1,
  },

  onWake(c, payload) {
    c.log.emit({ event: "budget-edge-probe.onWake", payload });
  },

  async onPlayerConnect(c, payload) {
    await c.ws.send(payload.playerId, {
      type: "ready",
      sessionId: payload.sessionId,
      connectedAt: payload.connectedAt,
    });
  },

  async onPlayerMessage(c, payload) {
    const body = isRecord(payload.body) ? payload.body : {};
    switch (body["type"]) {
      case "ws-rate":
        await runWsRateEdge(c, payload.playerId);
        return;
      case "ws-bandwidth":
        await runWsBandwidthEdge(c, payload.playerId);
        return;
      case "state-oversize":
        await runStateOversize(c);
        return;
      case "blob-key":
        await runBlobKeyEdge(c, payload.seq);
        return;
      case "api-call":
        await runApiCall(c, payload.seq);
        return;
      case "cpu-spin":
        runCpuSpin(readNumber(body["durationMs"], 1_200));
        return;
      default:
        c.log.emit({ event: "budget-edge-probe.unknown", body: payload.body });
    }
  },
});

async function runWsRateEdge(
  c: SubstrateContext,
  playerId: string,
): Promise<void> {
  for (let index = 0; index < 55; index += 1) {
    const response = await c.ws.send(playerId, { type: "rate-edge", index });
    if (!response.ok) {
      c.log.emit({ event: "budget-edge-probe.wsRate", response });
      return;
    }
  }
  c.log.emit({ event: "budget-edge-probe.wsRate", response: { ok: true } });
}

async function runWsBandwidthEdge(
  c: SubstrateContext,
  playerId: string,
): Promise<void> {
  const response = await c.ws.send(playerId, {
    type: "bandwidth-edge",
    payload: "x".repeat(70_000),
  });
  c.log.emit({ event: "budget-edge-probe.wsBandwidth", response });
}

async function runStateOversize(
  c: SubstrateContext,
): Promise<void> {
  const response = await c.state.write({
    type: "state-edge",
    payload: "x".repeat(150_000),
  });
  c.log.emit({ event: "budget-edge-probe.stateOversize", response });
}

async function runBlobKeyEdge(
  c: SubstrateContext,
  seq: number,
): Promise<void> {
  const response = await c.blob.put(`edge-${seq}.txt`, new Uint8Array([120]));
  if (!response.ok) {
    c.log.emit({ event: "budget-edge-probe.blobKey", seq, response });
  }
}

async function runApiCall(
  c: SubstrateContext,
  seq: number,
): Promise<void> {
  const response = await c.api.invoke(
    "mock-ai.v1",
    { messages: [{ role: "user", content: `budget-edge-${seq}` }] },
    { idempotencyKey: `budget-edge:${seq}` },
  );
  if (!response.ok) {
    c.log.emit({ event: "budget-edge-probe.apiCall", seq, response });
  }
}

function runCpuSpin(durationMs: number): void {
  const started = Date.now();
  while (Date.now() - started < durationMs) {
    Math.sqrt(started);
  }
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
