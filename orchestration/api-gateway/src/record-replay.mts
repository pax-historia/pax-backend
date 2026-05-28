import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import type { ApiInvokeError, ApiInvokeWireRecord } from "@pax-backend/ipc-protocol";

export interface WireRecordStore {
  record(record: ApiInvokeWireRecord): Promise<void>;
  lookup(fingerprint: string): Promise<ApiInvokeWireRecord | undefined>;
}

export class InMemoryWireRecordStore implements WireRecordStore {
  readonly #records = new Map<string, ApiInvokeWireRecord>();

  async record(record: ApiInvokeWireRecord): Promise<void> {
    this.#records.set(record.fingerprint, record);
  }

  async lookup(fingerprint: string): Promise<ApiInvokeWireRecord | undefined> {
    return this.#records.get(fingerprint);
  }
}

export class CompositeWireRecordStore implements WireRecordStore {
  constructor(
    readonly lookupStores: readonly WireRecordStore[],
    readonly recordStore: WireRecordStore,
  ) {}

  async record(record: ApiInvokeWireRecord): Promise<void> {
    await this.recordStore.record(record);
  }

  async lookup(fingerprint: string): Promise<ApiInvokeWireRecord | undefined> {
    for (const store of this.lookupStores) {
      const record = await store.lookup(fingerprint);
      if (record) return record;
    }
    return undefined;
  }
}

export class JsonlWireRecordStore implements WireRecordStore {
  readonly #records = new Map<string, ApiInvokeWireRecord>();
  #loaded = false;

  constructor(readonly path: string) {}

  async record(record: ApiInvokeWireRecord): Promise<void> {
    this.#records.set(record.fingerprint, record);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(record) + "\n", "utf8");
  }

  async lookup(fingerprint: string): Promise<ApiInvokeWireRecord | undefined> {
    await this.#loadOnce();
    return this.#records.get(fingerprint);
  }

  async #loadOnce(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    if (!existsSync(this.path)) return;
    const text = await readFile(this.path, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const parsed = JSON.parse(trimmed) as Partial<ApiInvokeWireRecord>;
      if (
        parsed.event === "api.invoke" &&
        typeof parsed.fingerprint === "string" &&
        typeof parsed.rawInbound === "string"
      ) {
        this.#records.set(parsed.fingerprint, parsed as ApiInvokeWireRecord);
      }
    }
  }
}

export class FixtureWireRecordStore implements WireRecordStore {
  readonly #records = new Map<string, ApiInvokeWireRecord>();
  #loaded = false;

  constructor(readonly path: string) {}

  async record(_record: ApiInvokeWireRecord): Promise<void> {
    // Fixture stores are read-only; replay attempts are recorded by the
    // paired JSONL store in CompositeWireRecordStore.
  }

  async lookup(fingerprint: string): Promise<ApiInvokeWireRecord | undefined> {
    await this.#loadOnce();
    return this.#records.get(fingerprint);
  }

  async #loadOnce(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    if (!existsSync(this.path)) return;
    const info = await stat(this.path);
    if (info.isDirectory()) {
      await this.#loadDirectory(this.path);
      return;
    }
    await this.#loadFile(this.path);
  }

  async #loadDirectory(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const childPath = join(path, entry.name);
      if (entry.isDirectory()) {
        await this.#loadDirectory(childPath);
        continue;
      }
      if (entry.isFile()) {
        await this.#loadFile(childPath);
      }
    }
  }

  async #loadFile(path: string): Promise<void> {
    const extension = extname(path);
    if (extension !== ".json" && extension !== ".jsonl") return;
    const raw = await readFile(path, "utf8");
    if (extension === ".jsonl") {
      for (const line of raw.split("\n")) {
        this.#maybeAddRecord(parseJson(line.trim()));
      }
      return;
    }
    const parsed = parseJson(raw);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) this.#maybeAddRecord(entry);
      return;
    }
    if (isRecord(parsed) && Array.isArray(parsed["records"])) {
      for (const entry of parsed["records"]) this.#maybeAddRecord(entry);
      return;
    }
    this.#maybeAddRecord(parsed);
  }

  #maybeAddRecord(raw: unknown): void {
    const record = normalizeWireRecord(raw);
    if (record) {
      this.#records.set(record.fingerprint, record);
    }
  }
}

function normalizeWireRecord(raw: unknown): ApiInvokeWireRecord | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw["event"] !== undefined && raw["event"] !== "api.invoke") return undefined;
  const fingerprint = readString(raw, "fingerprint");
  const rawInbound = readString(raw, "rawInbound");
  const statusCode = readNumber(raw, "statusCode");
  if (!fingerprint || !rawInbound || statusCode === undefined) return undefined;
  const mode = raw["mode"] === "replay" ? "replay" : "live";
  const error = readApiInvokeError(raw["error"]);
  return {
    event: "api.invoke",
    requestId: readString(raw, "requestId") ?? "fixture",
    fingerprint,
    mode,
    kind: readString(raw, "kind") ?? "fixture",
    gameId: readString(raw, "gameId") ?? "fixture",
    runId: readString(raw, "runId") ?? "fixture",
    rawOutbound: readString(raw, "rawOutbound") ?? "",
    rawInbound,
    statusCode,
    error,
    recordedAt: readString(raw, "recordedAt") ?? "1970-01-01T00:00:00.000Z",
  };
}

function parseJson(raw: string): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readString(record: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(record: Readonly<Record<string, unknown>>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readApiInvokeError(value: unknown): ApiInvokeError | undefined {
  return value === "kindUnknown" ||
    value === "providerError" ||
    value === "apiRateExceeded" ||
    value === "replayCoverageGap"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
