import { finding, numberField, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "eviction-minimum-budget";
const GUARANTEE = 10;
const MIN_SLEEP_DEADLINE_MS = 1_000;

export function evictionMinimumBudget(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event !== "onSleep.sent") continue;
    observed += 1;
    const reason = stringField(event, "reason");
    const deadline = numberField(event, "deadline");
    if (reason === "evicted" && (deadline === undefined || deadline < MIN_SLEEP_DEADLINE_MS)) {
      findings.push(
        finding("sleep-budget-too-small", "evicted onSleep deadline was below the minimum budget", event, {
          minimumMs: MIN_SLEEP_DEADLINE_MS,
          actualMs: deadline,
        }),
      );
    }
  }

  return result(ORACLE, GUARANTEE, history, Math.max(observed, history.length), findings);
}
