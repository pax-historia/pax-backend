import { finding, result } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "no-random-parent-crashes";
const GUARANTEE = 9;

const PARENT_LIVENESS_EVENTS = new Set([
  "parent.ready",
  "actor.start",
  "actor.stop",
  "child.exit",
  "child.restart",
  "lifecycle.sleepComplete",
]);

export function noRandomParentCrashes(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (PARENT_LIVENESS_EVENTS.has(event.event)) observed += 1;
    if (event.event === "parent.crash" || event.event === "parent.fatal") {
      observed += 1;
      findings.push(finding("parent-crash", "parent actor recorded an unexpected crash", event));
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
