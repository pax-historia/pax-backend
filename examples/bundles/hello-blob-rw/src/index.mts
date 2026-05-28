import { defineBundle } from "@pax-backend/runtime-sdk";

interface BlobMessage {
  readonly playerId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly body: unknown;
  readonly at: number;
}

interface BlobValue {
  readonly version: 1;
  readonly wakes: number;
  readonly revisions: number;
  readonly messages: readonly BlobMessage[];
}

let cachedBlob: BlobValue = emptyBlob();

export default defineBundle({
  manifest: {
    compatTagProduced: "blob-rw:v1",
    compatTagsAccepted: ["blob-rw:v1"],
    runtimeContractRequired: 1,
  },

  async onWake(c, payload) {
    const stored = normalizeBlob((await c.blob.read()) ?? payload.blob);
    const next = {
      ...stored,
      wakes: stored.wakes + 1,
    };
    const write = await c.blob.write(next);
    if (write.ok) cachedBlob = next;

    c.log.emit({
      event: "hello-blob-rw.onWake",
      blob: cachedBlob,
      payloadHadBlob: payload.blob !== undefined,
      write,
    });
  },

  onPlayerConnect(c, payload) {
    c.ws.send(payload.playerId, {
      type: "ready",
      bundle: "hello-blob-rw",
      sessionId: payload.sessionId,
      blob: cachedBlob,
    });
  },

  async onPlayerMessage(c, payload) {
    const stored = normalizeBlob(await c.blob.read());
    const message: BlobMessage = {
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      seq: payload.seq,
      body: payload.body,
      at: Date.now(),
    };
    const next: BlobValue = {
      version: 1,
      wakes: Math.max(cachedBlob.wakes, stored.wakes),
      revisions: stored.revisions + 1,
      messages: [...stored.messages.slice(-9), message],
    };
    const write = await c.blob.write(next);
    if (write.ok) cachedBlob = next;

    c.log.emit({
      event: "hello-blob-rw.write",
      playerId: payload.playerId,
      sessionId: payload.sessionId,
      seq: payload.seq,
      write,
      blob: cachedBlob,
    });
    c.ws.send(payload.playerId, {
      type: "blob",
      seq: payload.seq,
      write,
      blob: cachedBlob,
    });
  },
});

function emptyBlob(): BlobValue {
  return {
    version: 1,
    wakes: 0,
    revisions: 0,
    messages: [],
  };
}

function normalizeBlob(value: unknown): BlobValue {
  if (!isRecord(value) || value["version"] !== 1) return emptyBlob();
  return {
    version: 1,
    wakes: readNonNegativeInt(value["wakes"]),
    revisions: readNonNegativeInt(value["revisions"]),
    messages: normalizeMessages(value["messages"]),
  };
}

function normalizeMessages(value: unknown): readonly BlobMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const seq = entry["seq"];
    if (typeof entry["playerId"] !== "string" || typeof entry["sessionId"] !== "string") {
      return [];
    }
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return [];
    return [
      {
        playerId: entry["playerId"],
        sessionId: entry["sessionId"],
        seq,
        body: entry["body"],
        at: readNonNegativeInt(entry["at"]),
      },
    ];
  });
}

function readNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
