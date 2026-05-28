import { booleanField, finding, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "compute-plane-quotas";
const GUARANTEE = 7;
const STORAGE_ERRORS = new Set(["sizeExceeded", "storageUnavailable"]);
const API_ERRORS = new Set([
  "apiRateExceeded",
  "kindUnknown",
  "providerError",
  "replayCoverageGap",
]);
const WS_ERRORS = new Set([
  "bandwidthExceeded",
  "rateExceeded",
  "serializationFailed",
]);
const HANDLER_ERROR_CODES = new Set(["handlerError", "handlerTimeout"]);
const COMPUTE_BUDGETS = new Set([
  "cpu-ms-per-tick",
  "memory-bytes",
  "bandwidth-bytes-per-sec",
  "ws-messages-per-sec",
  "state-bytes",
  "blob-bytes",
  "api-invocations-per-min",
]);

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
    if (event.event === "ws.send.rejected") {
      observed += 1;
      const error = stringField(event, "error");
      if (!error || !WS_ERRORS.has(error)) {
        findings.push(finding("untyped-ws-quota-error", "ws.send used an unknown error", event));
      }
    }
    if (event.event === "child.handlerError") {
      const code = stringField(event, "code");
      if (!code || !HANDLER_ERROR_CODES.has(code)) {
        findings.push(
          finding("untyped-handler-error", "child.handlerError used an unknown code", event),
        );
      }
      if (code === "handlerTimeout") observed += 1;
    }
    if (event.event === "compute.budget.rejected") {
      const budget = stringField(event, "budget");
      if (budget === "cpu-ms-per-tick") observed += 1;
      if (budget && !COMPUTE_BUDGETS.has(budget)) {
        findings.push(
          finding(
            "unknown-compute-budget",
            "compute.budget.rejected used an unknown budget",
            event,
          ),
        );
      }
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
