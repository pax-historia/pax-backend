import { defineBundle, type SubstrateContext } from "@pax-backend/runtime-sdk";

interface SnapshotValue {
  readonly version: 1;
  readonly marker: string;
  readonly writes: number;
}

const BLOB_KEY = "snapshot.json";
const INITIAL_MARKER = "seed";

let cachedState: SnapshotValue = emptySnapshot();
let cachedBlob: SnapshotValue = emptySnapshot();

export default defineBundle({
  manifest: {
    compatTagProduced: "checkpoint-skew:v1",
    compatTagsAccepted: ["checkpoint-skew:v1"],
    runtimeContractRequired: 1,
  },

  async onWake(c, payload) {
    cachedState = normalizeSnapshot((await c.state.read()) ?? payload.state);
    cachedBlob = normalizeSnapshot(decodeJson(await c.blob.get(BLOB_KEY)));
    emitSnapshot(c, "checkpoint-skew.onWake", payload.reason);
  },

  onPlayerConnect(c, payload) {
    c.ws.send(payload.playerId, {
      type: "ready",
      bundle: "checkpoint-skew-probe",
      sessionId: payload.sessionId,
      state: cachedState,
      blob: cachedBlob,
    });
  },

  async onPlayerMessage(c, payload) {
    const body = isRecord(payload.body) ? payload.body : {};
    const type = typeof body["type"] === "string" ? body["type"] : "probe";
    const marker = typeof body["marker"] === "string" ? body["marker"] : cachedState.marker;

    if (type === "commit" || type === "dirty") {
      const written = await writeSnapshot(c, marker, type === "commit");
      c.log.emit({
        event: type === "commit" ? "checkpoint-skew.commit" : "checkpoint-skew.dirty",
        playerId: payload.playerId,
        sessionId: payload.sessionId,
        seq: payload.seq,
        marker,
        ...written,
      });
      c.ws.send(payload.playerId, {
        type,
        seq: payload.seq,
        marker,
        state: cachedState,
        blob: cachedBlob,
        ...written,
      });
      return;
    }

    cachedState = normalizeSnapshot(await c.state.read());
    cachedBlob = normalizeSnapshot(decodeJson(await c.blob.get(BLOB_KEY)));
    emitSnapshot(c, "checkpoint-skew.probe", marker);
    c.ws.send(payload.playerId, {
      type: "probe",
      seq: payload.seq,
      state: cachedState,
      blob: cachedBlob,
      skew: cachedState.marker !== cachedBlob.marker,
    });
  },

  onSleep(c, payload) {
    c.log.emit({
      event: "checkpoint-skew.onSleep",
      reason: payload.reason,
      state: cachedState,
      blob: cachedBlob,
    });
  },
});

async function writeSnapshot(
  c: SubstrateContext,
  marker: string,
  flush: boolean,
): Promise<Record<string, unknown>> {
  const state = normalizeSnapshot(await c.state.read());
  const blob = normalizeSnapshot(decodeJson(await c.blob.get(BLOB_KEY)));
  const next: SnapshotValue = {
    version: 1,
    marker,
    writes: Math.max(state.writes, blob.writes) + 1,
  };
  const stateWrite = await c.state.write(next);
  const blobWrite = await c.blob.put(BLOB_KEY, encodeJson(next));
  const stateFlush = flush && stateWrite.ok && blobWrite.ok ? await c.state.flush() : undefined;
  if (stateWrite.ok) cachedState = next;
  if (blobWrite.ok) cachedBlob = next;
  return { stateWrite, blobWrite, stateFlush };
}

function emitSnapshot(
  c: SubstrateContext,
  event: string,
  marker: string,
): void {
  c.log.emit({
    event,
    marker,
    state: cachedState,
    blob: cachedBlob,
    stateMarker: cachedState.marker,
    blobMarker: cachedBlob.marker,
    skew: cachedState.marker !== cachedBlob.marker,
  });
}

function emptySnapshot(): SnapshotValue {
  return {
    version: 1,
    marker: INITIAL_MARKER,
    writes: 0,
  };
}

function normalizeSnapshot(value: unknown): SnapshotValue {
  if (!isRecord(value) || value["version"] !== 1) return emptySnapshot();
  return {
    version: 1,
    marker: typeof value["marker"] === "string" ? value["marker"] : INITIAL_MARKER,
    writes: readNonNegativeInt(value["writes"]),
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

function readNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
