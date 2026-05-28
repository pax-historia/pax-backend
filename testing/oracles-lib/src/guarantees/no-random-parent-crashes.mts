import { finding, result } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "no-random-parent-crashes";
const GUARANTEE = 9;

export function noRandomParentCrashes(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event === "parent.ready" || event.event === "actor.stop") observed += 1;
    if (event.event === "parent.crash" || event.event === "parent.fatal") {
      observed += 1;
      findings.push(finding("parent-crash", "parent actor recorded an unexpected crash", event));
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
