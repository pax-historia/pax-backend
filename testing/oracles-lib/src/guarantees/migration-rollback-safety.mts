import { finding, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "migration-rollback-safety";
const GUARANTEE = 13;

export function migrationRollbackSafety(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event === "bundle.rollback") {
      observed += 1;
      if (!stringField(event, "gameId") || !stringField(event, "bundleName")) {
        findings.push(
          finding("missing-rollback-scope", "bundle.rollback must include gameId and bundleName", event),
        );
      }
    }
    if (event.event === "child.handlerError" && stringField(event, "handler") === "onWake") {
      observed += 1;
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
