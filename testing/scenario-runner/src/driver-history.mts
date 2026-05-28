import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const DRIVER_SHARD_ID = "scenario-runner";

export class HistoryWriter {
  #nextSeq: number;

  constructor(
    readonly historyPath: string,
    readonly shardId = DRIVER_SHARD_ID,
  ) {
    this.#nextSeq = loadLastPaxSeqForShard(historyPath, shardId) + 1;
  }

  append(event: string, fields: Readonly<Record<string, unknown>>): void {
    mkdirSync(dirname(this.historyPath), { recursive: true });
    const paxSeq = this.#nextSeq;
    this.#nextSeq += 1;
    appendFileSync(
      this.historyPath,
      JSON.stringify({
        ...fields,
        ts: new Date().toISOString(),
        shardId: this.shardId,
        pax_seq: paxSeq,
        event,
      }) + "\n",
      "utf8",
    );
  }
}

function loadLastPaxSeqForShard(path: string, shardId: string): number {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  const lines = raw.trimEnd().split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as {
        readonly shardId?: unknown;
        readonly pax_seq?: unknown;
      };
      if (
        parsed.shardId === shardId &&
        typeof parsed.pax_seq === "number" &&
        Number.isInteger(parsed.pax_seq)
      ) {
        return parsed.pax_seq;
      }
    } catch {
      continue;
    }
  }
  return 0;
}
