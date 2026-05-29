import { booleanField, finding, numberField, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "state-durability";
const GUARANTEE = 11;

export function stateDurability(history: readonly HistoryEvent[]): OracleResult {
  const hasSuccessfulWrite = new Set<string>();
  const lastCheckpointSeqByGame = new Map<string, number>();
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (
      event.event !== "state.write" &&
      event.event !== "state.read" &&
      event.event !== "state.flush" &&
      event.event !== "state.flush.plannedTransition" &&
      event.event !== "state.checkpoint"
    ) {
      continue;
    }
    observed += 1;
    const gameId = stringField(event, "gameId");
    if (!gameId) {
      findings.push(finding("missing-gameid", `${event.event} must include gameId`, event));
      continue;
    }
    if (event.event === "state.write" && booleanField(event, "ok") !== false) {
      hasSuccessfulWrite.add(gameId);
      continue;
    }
    if (
      event.event === "state.flush" ||
      event.event === "state.flush.plannedTransition" ||
      event.event === "state.checkpoint"
    ) {
      const checkpointSeq = numberField(event, "checkpointSeq");
      if (checkpointSeq !== undefined) {
        const previous = lastCheckpointSeqByGame.get(gameId);
        if (previous !== undefined && checkpointSeq <= previous) {
          findings.push(
            finding("checkpoint-seq-not-monotonic", "checkpointSeq must increase per game", event, {
              previous,
              checkpointSeq,
            }),
          );
        }
        lastCheckpointSeqByGame.set(gameId, checkpointSeq);
      }
      continue;
    }
    if (
      event.event === "state.read" &&
      hasSuccessfulWrite.has(gameId) &&
      booleanField(event, "found") === false
    ) {
      findings.push(
        finding("state-lost-after-write", "state.read returned empty after a successful state.write", event),
      );
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
