import { booleanField, finding, numberField, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "blob-durability";
const GUARANTEE = 12;

export function blobDurability(history: readonly HistoryEvent[]): OracleResult {
  const hasSuccessfulWrite = new Set<string>();
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of [...history].sort(compareEventOrder)) {
    if (
      event.event !== "blob.put" &&
      event.event !== "blob.get" &&
      event.event !== "blob.delete" &&
      event.event !== "state.fence.conflict" &&
      event.event !== "state.fence.winner" &&
      event.event !== "state.restore"
    ) {
      continue;
    }
    observed += 1;
    const gameId = stringField(event, "gameId");
    if (!gameId) {
      findings.push(finding("missing-gameid", `${event.event} must include gameId`, event));
      continue;
    }
    if (
      event.event === "state.fence.conflict" ||
      event.event === "state.fence.winner" ||
      event.event === "state.restore"
    ) {
      clearGame(hasSuccessfulWrite, gameId);
      continue;
    }
    const key = stringField(event, "key");
    if (!key) {
      findings.push(finding("missing-key", `${event.event} must include key`, event));
      continue;
    }
    if (event.event === "blob.put" && booleanField(event, "ok") !== false) {
      hasSuccessfulWrite.add(blobScope(gameId, key));
      continue;
    }
    if (event.event === "blob.delete") {
      hasSuccessfulWrite.delete(blobScope(gameId, key));
      continue;
    }
    if (
      event.event === "blob.get" &&
      hasSuccessfulWrite.has(blobScope(gameId, key)) &&
      booleanField(event, "found") === false
    ) {
      findings.push(
        finding("blob-lost-after-write", "blob.get returned empty after a successful blob.put", event),
      );
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}

function blobScope(gameId: string, key: string): string {
  return `${gameId}\0${key}`;
}

function clearGame(values: Set<string>, gameId: string): void {
  const prefix = `${gameId}\0`;
  for (const value of values) {
    if (value.startsWith(prefix)) values.delete(value);
  }
}

function compareEventOrder(left: HistoryEvent, right: HistoryEvent): number {
  const leftTime = Date.parse(stringField(left, "ts") ?? "");
  const rightTime = Date.parse(stringField(right, "ts") ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  const leftSeq = numberField(left, "pax_seq");
  const rightSeq = numberField(right, "pax_seq");
  if (left.shardId === right.shardId && leftSeq !== undefined && rightSeq !== undefined) {
    return leftSeq - rightSeq;
  }
  return 0;
}
