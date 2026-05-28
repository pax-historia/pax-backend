import { defineBundle } from "@pax-backend/runtime-sdk";

interface MessageSummary {
  readonly playerId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly body: unknown;
  readonly at: number;
  readonly sample: number;
}

interface MultiFeatureState {
  readonly version: 1;
  readonly wakes: number;
  readonly messages: number;
  readonly apiCalls: number;
  readonly lastMessage?: MessageSummary;
}

interface MultiFeatureBlob {
  readonly version: 1;
  readonly wakes: number;
  readonly revisions: number;
  readonly recentMessages: readonly MessageSummary[];
  readonly lastApiResult?: unknown;
}

const connectedPlayers = new Set<string>();
let cachedState: MultiFeatureState = emptyState();
let cachedBlob: MultiFeatureBlob = emptyBlob();
const BLOB_KEY = "current.json";

export default defineBundle({
  manifest: {
    compatTagProduced: "multifeature:v1",
    compatTagsAccepted: ["multifeature:v1"],
    runtimeContractRequired: 1,
  },

  async onWake(c, payload) {
    const [storedStateRaw, storedBlobRaw, allowedPlayers, connectedSessions, budget] = await Promise.all([
      c.state.read(),
      c.blob.get(BLOB_KEY),
      c.players.allowed(),
      c.players.connected(),
      c.compute.budget(),
    ]);

    const storedState = normalizeState(storedStateRaw ?? payload.state);
    const storedBlob = normalizeBlob(decodeJson(storedBlobRaw));
    const nextState: MultiFeatureState = {
      ...storedState,
      wakes: storedState.wakes + 1,
    };
    const nextBlob: MultiFeatureBlob = {
      ...storedBlob,
      wakes: storedBlob.wakes + 1,
    };

    const stateWrite = await c.state.write(nextState);
    const stateFlush = stateWrite.ok ? await c.state.flush() : stateWrite;
    const blobWrite = await c.blob.put(BLOB_KEY, encodeJson(nextBlob));
    if (stateWrite.ok && stateFlush.ok) cachedState = nextState;
    if (blobWrite.ok) cachedBlob = nextBlob;

    c.metrics.emit({
      name: "hello_multifeature.wake",
      kind: "counter",
      value: 1,
      tags: { reason: payload.reason },
    });
    c.metrics.emit({
      name: "hello_multifeature.connected_sessions",
      kind: "gauge",
      value: connectedSessions.length,
    });
    c.log.emit({
      event: "hello-multifeature.onWake",
      reason: payload.reason,
      bundleName: payload.bundleName,
      runId: payload.runId,
      allowedPlayers,
      connectedSessions,
      budget,
      stateWrite,
      stateFlush,
      blobWrite,
    });
  },

  async onPlayerConnect(c, payload) {
    connectedPlayers.add(payload.playerId);
    const [allowedPlayers, connectedSessions, budget] = await Promise.all([
      c.players.allowed(),
      c.players.connected(),
      c.compute.budget(),
    ]);

    c.metrics.emit({
      name: "hello_multifeature.players_connected",
      kind: "gauge",
      value: connectedPlayers.size,
    });
    c.log.emit({
      event: "hello-multifeature.onPlayerConnect",
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      connectedAt: payload.connectedAt,
      allowedPlayers,
      connectedSessions,
      budget,
    });
    c.ws.send(payload.playerId, {
      type: "ready",
      bundle: "hello-multifeature",
      sessionId: payload.sessionId,
      connectedAt: payload.connectedAt,
      state: cachedState,
      blob: cachedBlob,
      connectedPlayers: connectedPlayers.size,
    });
  },

  async onPlayerMessage(c, payload) {
    const [storedStateRaw, storedBlobRaw, allowedPlayers, connectedSessions, budgetBefore] =
      await Promise.all([
        c.state.read(),
        c.blob.get(BLOB_KEY),
        c.players.allowed(),
        c.players.connected(),
        c.compute.budget(),
      ]);
    const sample = c.rng();
    const message: MessageSummary = {
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      seq: payload.seq,
      body: payload.body,
      at: c.now(),
      sample,
    };
    const storedState = normalizeState(storedStateRaw);
    const storedBlob = normalizeBlob(decodeJson(storedBlobRaw));

    const nextState: MultiFeatureState = {
      version: 1,
      wakes: Math.max(cachedState.wakes, storedState.wakes),
      messages: storedState.messages + 1,
      apiCalls: storedState.apiCalls + 1,
      lastMessage: message,
    };
    const stateWrite = await c.state.write(nextState);
    const stateFlush = stateWrite.ok ? await c.state.flush() : stateWrite;
    if (stateWrite.ok && stateFlush.ok) cachedState = nextState;

    const apiResponse = await c.api.invoke(
      "mock-ai.v1",
      {
        messages: [
          {
            role: "user",
            content: JSON.stringify(payload.body),
          },
        ],
        sample,
        playerId: payload.playerId,
        sessionId: payload.sessionId,
        seq: payload.seq,
      },
      { idempotencyKey: `${payload.sessionId}:${payload.seq}:hello-multifeature` },
    );

    const nextBlob: MultiFeatureBlob = {
      version: 1,
      wakes: Math.max(cachedBlob.wakes, storedBlob.wakes),
      revisions: storedBlob.revisions + 1,
      recentMessages: [...storedBlob.recentMessages.slice(-9), message],
      lastApiResult: apiResponse,
    };
    const blobWrite = await c.blob.put(BLOB_KEY, encodeJson(nextBlob));
    if (blobWrite.ok) cachedBlob = nextBlob;

    const budgetAfter = await c.compute.budget();
    c.metrics.emit({
      name: "hello_multifeature.messages",
      kind: "counter",
      value: 1,
      tags: { api: apiResponse.ok ? "ok" : apiResponse.error },
    });
    c.log.emit({
      event: "hello-multifeature.onPlayerMessage",
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      seq: payload.seq,
      sample,
      allowedPlayers,
      connectedSessions,
      budgetBefore,
      budgetAfter,
      stateWrite,
      stateFlush,
      blobWrite,
      apiOk: apiResponse.ok,
      apiError: apiResponse.ok ? undefined : apiResponse.error,
    });
    c.ws.send(payload.playerId, {
      type: "multifeature",
      seq: payload.seq,
      state: cachedState,
      blob: cachedBlob,
      apiResponse,
      connectedSessions,
      budgetBefore,
      budgetAfter,
      sample,
    });
  },

  onPlayerDisconnect(c, payload) {
    connectedPlayers.delete(payload.playerId);
    c.metrics.emit({
      name: "hello_multifeature.players_connected",
      kind: "gauge",
      value: connectedPlayers.size,
    });
    c.log.emit({
      event: "hello-multifeature.onPlayerDisconnect",
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      reason: payload.reason,
      connectedPlayers: connectedPlayers.size,
    });
  },

  onSleep(c, payload) {
    c.log.emit({
      event: "hello-multifeature.onSleep",
      reason: payload.reason,
      deadline: payload.deadline,
      state: cachedState,
      blob: cachedBlob,
      connectedPlayers: connectedPlayers.size,
    });
  },

  onCapacityWarning(c, payload) {
    c.metrics.emit({
      name: "hello_multifeature.capacity_warning",
      kind: "counter",
      value: 1,
      tags: { budget: payload.budget },
    });
    c.log.emit({
      event: "hello-multifeature.onCapacityWarning",
      payload,
    });
  },
});

function emptyState(): MultiFeatureState {
  return {
    version: 1,
    wakes: 0,
    messages: 0,
    apiCalls: 0,
  };
}

function emptyBlob(): MultiFeatureBlob {
  return {
    version: 1,
    wakes: 0,
    revisions: 0,
    recentMessages: [],
  };
}

function normalizeState(value: unknown): MultiFeatureState {
  if (!isRecord(value) || value["version"] !== 1) return emptyState();
  return {
    version: 1,
    wakes: readNonNegativeInt(value["wakes"]),
    messages: readNonNegativeInt(value["messages"]),
    apiCalls: readNonNegativeInt(value["apiCalls"]),
    lastMessage: normalizeMessage(value["lastMessage"]),
  };
}

function normalizeBlob(value: unknown): MultiFeatureBlob {
  if (!isRecord(value) || value["version"] !== 1) return emptyBlob();
  return {
    version: 1,
    wakes: readNonNegativeInt(value["wakes"]),
    revisions: readNonNegativeInt(value["revisions"]),
    recentMessages: normalizeMessages(value["recentMessages"]),
    lastApiResult: value["lastApiResult"],
  };
}

function encodeJson(value: unknown): Uint8Array {
  const raw = JSON.stringify(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function decodeJson(bytes: Uint8Array | null): unknown {
  if (!bytes) return undefined;
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function normalizeMessages(value: unknown): readonly MessageSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const message = normalizeMessage(entry);
    return message === undefined ? [] : [message];
  });
}

function normalizeMessage(value: unknown): MessageSummary | undefined {
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
    sample: readFiniteNumber(value["sample"]),
  };
}

function readNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readFiniteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
