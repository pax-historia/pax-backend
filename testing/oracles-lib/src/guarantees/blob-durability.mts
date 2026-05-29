import { booleanField, finding, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "blob-durability";
const GUARANTEE = 12;

export function blobDurability(history: readonly HistoryEvent[]): OracleResult {
  const hasSuccessfulWrite = new Set<string>();
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event !== "blob.put" && event.event !== "blob.get") continue;
    observed += 1;
    const gameId = stringField(event, "gameId");
    if (!gameId) {
      findings.push(finding("missing-gameid", `${event.event} must include gameId`, event));
      continue;
    }
    if (event.event === "blob.put" && booleanField(event, "ok") !== false) {
      hasSuccessfulWrite.add(gameId);
      continue;
    }
    if (
      event.event === "blob.get" &&
      hasSuccessfulWrite.has(gameId) &&
      booleanField(event, "found") === false
    ) {
      findings.push(
        finding("blob-lost-after-write", "blob.get returned empty after a successful blob.put", event),
      );
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
