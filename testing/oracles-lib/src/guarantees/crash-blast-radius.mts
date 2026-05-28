import { finding, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "crash-blast-radius";
const GUARANTEE = 8;

export function crashBlastRadius(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event !== "child.exit" && event.event !== "child.fatal") continue;
    observed += 1;
    if (!stringField(event, "gameId") || !stringField(event, "actorId")) {
      findings.push(
        finding("unscoped-child-failure", "child failure event must be scoped to one actor and game", event),
      );
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
