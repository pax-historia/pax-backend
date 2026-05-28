import { finding, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "bundle-compatibility-safety";
const GUARANTEE = 15;

export function bundleCompatibilitySafety(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event === "bundle.flip.rejected" || event.event === "bundle.coldWake.rejected") {
      observed += 1;
      if (stringField(event, "error") !== "compatTagOutOfRange") {
        findings.push(
          finding(
            "unexpected-compat-rejection",
            "bundle compat rejection was not compatTagOutOfRange",
            event,
          ),
        );
      }
      continue;
    }
    if (event.event === "onWake.sent") {
      observed += 1;
      if (!stringField(event, "bundleCompatTag")) {
        findings.push(finding("missing-bundle-compat-tag", "onWake.sent must include bundleCompatTag", event));
      }
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
