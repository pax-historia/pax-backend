import { finding, numberField, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "placement-contract-safety";
const GUARANTEE = 16;

export function placementContractSafety(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event === "parent.ready") {
      observed += 1;
      if (!Array.isArray(event["runtimeContractsSupported"])) {
        findings.push(
          finding("missing-runtime-contract-range", "parent.ready must include runtimeContractsSupported", event),
        );
      }
      continue;
    }
    if (event.event === "placement.rejected") {
      observed += 1;
      const error = stringField(event, "error");
      if (error === "contractOutOfRange" && numberField(event, "required") === undefined) {
        findings.push(
          finding("missing-required-contract", "contractOutOfRange must include required contract", event),
        );
      }
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
