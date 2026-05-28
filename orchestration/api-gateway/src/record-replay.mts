import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ApiInvokeWireRecord } from "@pax-backend/ipc-protocol";

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
