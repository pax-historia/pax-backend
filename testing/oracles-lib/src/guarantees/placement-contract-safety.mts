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
    if (event.event === "placement.accepted") {
      observed += 1;
      const required = contractRequired(event);
      const supported = contractRange(event);
      if (required === undefined) {
        findings.push(
          finding(
            "missing-required-contract",
            "placement.accepted must include required contract",
            event,
          ),
        );
      }
      if (!supported) {
        findings.push(
          finding(
            "missing-runtime-contract-range",
            "placement.accepted must include runtimeContractsSupported",
            event,
          ),
        );
      }
      if (
        required !== undefined &&
        supported &&
        (required < supported[0] || required > supported[1])
      ) {
        findings.push(
          finding(
            "accepted-contract-out-of-range",
            "placement.accepted routed a bundle to a shard that does not support its contract",
            event,
            { required, supported },
          ),
        );
      }
      continue;
    }
    if (event.event === "placement.rejected") {
      observed += 1;
      const error = stringField(event, "error");
      if (error === "contractOutOfRange" && contractRequired(event) === undefined) {
        findings.push(
          finding("missing-required-contract", "contractOutOfRange must include required contract", event),
        );
      }
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}

function contractRequired(event: HistoryEvent): number | undefined {
  return numberField(event, "runtimeContractRequired") ?? numberField(event, "required");
}

function contractRange(event: HistoryEvent): readonly [number, number] | undefined {
  const value = event["runtimeContractsSupported"];
  if (Array.isArray(value) && value.length === 2) {
    const min = value[0];
    const max = value[1];
    if (typeof min === "number" && typeof max === "number") {
      return [min, max];
    }
  }
  return undefined;
}
