import { defineBundle } from "@pax-backend/runtime-sdk";

interface StateValue {
  readonly version: 1;
  readonly wakes: number;
  readonly messages: number;
  readonly lastMessage?: {
    readonly playerId: string;
    readonly sessionId: string;
    readonly seq: number;
    readonly body: unknown;
    readonly at: number;
  };
}

let cachedState: StateValue = emptyState();

export default defineBundle({
  manifest: {
    compatTagProduced: "state-rw:v1",
    compatTagsAccepted: ["state-rw:v1"],
    runtimeContractRequired: 1,
  },

  async onWake(c, payload) {
    const stored = normalizeState((await c.state.read()) ?? payload.state);
    const next = { ...stored, wakes: stored.wakes + 1 };
    const write = await c.state.write(next);
    const flush = write.ok ? await c.state.flush() : write;
    if (write.ok && flush.ok) cachedState = next;

    c.log.emit({
      event: "hello-state-rw.onWake",
      state: cachedState,
      payloadHadState: payload.state !== undefined,
      write,
      flush,
    });
  },

  onPlayerConnect(c, payload) {
    c.ws.send(payload.playerId, {
      type: "ready",
      bundle: "hello-state-rw",
      sessionId: payload.sessionId,
      state: cachedState,
    });
  },

  async onPlayerMessage(c, payload) {
    const stored = normalizeState(await c.state.read());
    const next: StateValue = {
      version: 1,
      wakes: Math.max(cachedState.wakes, stored.wakes),
      messages: stored.messages + 1,
      lastMessage: {
        playerId: payload.playerId,
        sessionId: payload.sessionId,
        seq: payload.seq,
        body: payload.body,
        at: c.now(),
      },
    };
    const write = await c.state.write(next);
    const flush = write.ok ? await c.state.flush() : write;
    if (write.ok && flush.ok) cachedState = next;

    c.log.emit({
      event: "hello-state-rw.write",
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      seq: payload.seq,
      write,
      flush,
      state: cachedState,
    });
    c.ws.send(payload.playerId, {
      type: "state",
      seq: payload.seq,
      write,
      flush,
      state: cachedState,
    });
  },
});

function emptyState(): StateValue {
  return {
    version: 1,
    wakes: 0,
    messages: 0,
  };
}

function normalizeState(value: unknown): StateValue {
  if (!isRecord(value) || value["version"] !== 1) return emptyState();
  return {
    version: 1,
    wakes: readNonNegativeInt(value["wakes"]),
    messages: readNonNegativeInt(value["messages"]),
    lastMessage: normalizeLastMessage(value["lastMessage"]),
  };
}

function normalizeLastMessage(value: unknown): StateValue["lastMessage"] {
  if (!isRecord(value)) return undefined;
  const seq = value["seq"];
  if (typeof value["playerId"] !== "string" || typeof value["sessionId"] !== "string") {
    return undefined;
  }
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return undefined;
  return {
    playerId: value["playerId"],
    sessionId: value["sessionId"],
    seq,
    body: value["body"],
    at: readNonNegativeInt(value["at"]),
  };
}

function readNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
