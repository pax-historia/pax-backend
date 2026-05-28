import { booleanField, finding, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "compute-plane-quotas";
const GUARANTEE = 7;
const STORAGE_ERRORS = new Set(["sizeExceeded", "storageUnavailable"]);
const API_ERRORS = new Set(["apiRateExceeded", "kindUnknown", "providerError", "replayCoverageGap"]);

export function computePlaneQuotas(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event === "compute.budget") {
      observed += 1;
      continue;
    }
    if (event.event === "state.write" || event.event === "blob.write") {
      observed += 1;
      if (booleanField(event, "ok") === false) {
        const error = stringField(event, "error");
        if (!error || !STORAGE_ERRORS.has(error)) {
          findings.push(finding("untyped-storage-quota-error", "storage write used an unknown error", event));
        }
      }
      continue;
    }
    if (event.event === "api.invoke.response" && booleanField(event, "ok") === false) {
      const error = stringField(event, "error");
      if (error === "apiRateExceeded") observed += 1;
      if (error && !API_ERRORS.has(error)) {
        findings.push(finding("untyped-api-quota-error", "api invoke used an unknown error", event));
      }
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
