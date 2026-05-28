import { defineBundle } from "@pax-backend/runtime-sdk";

const BUNDLE_NAME = "race-edge-probe-v1";
const COMPAT_TAG = "race-edge:v1";
const ACCEPTED_COMPAT_TAGS = ["race-edge:v1"] as const;
const BLOB_KEY = "race-edge.json";

interface ProbeState {
  readonly version: 1;
  readonly bundleName: string;
  readonly wakes: number;
  readonly messages: number;
  readonly hostEvents: number;
  readonly sleeps: number;
  readonly lastEventType?: string;
}

let cachedState: ProbeState = emptyState();

export default defineBundle({
  manifest: {
    compatTagProduced: COMPAT_TAG,
    compatTagsAccepted: [...ACCEPTED_COMPAT_TAGS],
    runtimeContractRequired: 1,
  },

  async onWake(c, payload) {
    const stored = normalizeState(await c.state.read());
    cachedState = {
      ...stored,
      bundleName: BUNDLE_NAME,
      wakes: stored.wakes + 1,
    };
    const stateWrite = await c.state.write(cachedState);
    const blobWrite = await c.blob.put(BLOB_KEY, encodeJson(cachedState));
    c.log.emit({
      event: "race-edge-probe.onWake",
      bundleName: BUNDLE_NAME,
      compatTag: COMPAT_TAG,
      reason: payload.reason,
      blobCompatTag: payload.blobCompatTag,
      stateWrite,
      blobWrite,
      state: cachedState,
    });
  },

  async onPlayerConnect(c, payload) {
    await c.ws.send(payload.playerId, {
      type: "ready",
      bundle: BUNDLE_NAME,
      compatTag: COMPAT_TAG,
      sessionId: payload.sessionId,
      connectedAt: payload.connectedAt,
      state: cachedState,
    });
  },

  async onPlayerMessage(c, payload) {
    const body = isRecord(payload.body) ? payload.body : {};
    cachedState = {
      ...cachedState,
      messages: cachedState.messages + 1,
    };
    await c.state.write(cachedState);
    await c.blob.put(BLOB_KEY, encodeJson(cachedState));
    c.log.emit({
      event: "race-edge-probe.onPlayerMessage",
      bundleName: BUNDLE_NAME,
      compatTag: COMPAT_TAG,
      seq: payload.seq,
      body: payload.body,
      state: cachedState,
    });
    if (body["type"] === "request-sleep") {
      c.lifecycle.requestSleep();
      return;
    }
    await c.ws.send(payload.playerId, {
      type: "race-edge",
      bundle: BUNDLE_NAME,
      compatTag: COMPAT_TAG,
      seq: payload.seq,
      state: cachedState,
    });
  },

  async onSleep(c, payload) {
    cachedState = {
      ...cachedState,
      sleeps: cachedState.sleeps + 1,
    };
    const stateWrite = await c.state.write(cachedState);
    const stateFlush = stateWrite.ok ? await c.state.flush() : stateWrite;
    const blobWrite = await c.blob.put(BLOB_KEY, encodeJson(cachedState));
    spin(120);
    c.log.emit({
      event: "race-edge-probe.onSleep",
      bundleName: BUNDLE_NAME,
      compatTag: COMPAT_TAG,
      reason: payload.reason,
      deadline: payload.deadline,
      stateWrite,
      stateFlush,
      blobWrite,
      state: cachedState,
    });
  },

  async onHostEvent(c, payload) {
    cachedState = {
      ...cachedState,
      hostEvents: cachedState.hostEvents + 1,
      lastEventType: payload.eventType,
    };
    const stateWrite = await c.state.write(cachedState);
    const stateFlush = stateWrite.ok ? await c.state.flush() : stateWrite;
    const blobWrite = await c.blob.put(BLOB_KEY, encodeJson(cachedState));
    c.log.emit({
      event: "race-edge-probe.onHostEvent",
      bundleName: BUNDLE_NAME,
      compatTag: COMPAT_TAG,
      eventId: payload.eventId,
      eventType: payload.eventType,
      deliveryAttempts: payload.deliveryAttempts,
      payload: payload.payload,
      stateWrite,
      stateFlush,
      blobWrite,
      state: cachedState,
    });
  },
});

function emptyState(): ProbeState {
  return {
    version: 1,
    bundleName: BUNDLE_NAME,
    wakes: 0,
    messages: 0,
    hostEvents: 0,
    sleeps: 0,
  };
}

function normalizeState(value: unknown): ProbeState {
  if (!isRecord(value) || value["version"] !== 1) return emptyState();
  return {
    version: 1,
    bundleName: typeof value["bundleName"] === "string" ? value["bundleName"] : BUNDLE_NAME,
    wakes: readNonNegativeInt(value["wakes"]),
    messages: readNonNegativeInt(value["messages"]),
    hostEvents: readNonNegativeInt(value["hostEvents"]),
    sleeps: readNonNegativeInt(value["sleeps"]),
    lastEventType: typeof value["lastEventType"] === "string" ? value["lastEventType"] : undefined,
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

function spin(durationMs: number): void {
  const started = Date.now();
  while (Date.now() - started < durationMs) {
    Math.sqrt(started);
  }
}

function readNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
