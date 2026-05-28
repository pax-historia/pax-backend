import { booleanField, finding, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "faithful-api-dispatch";
const GUARANTEE = 5;
const API_ERRORS = new Set(["kindUnknown", "providerError", "apiRateExceeded", "replayCoverageGap"]);

export function faithfulApiDispatch(history: readonly HistoryEvent[]): OracleResult {
  const requests = new Map<string, HistoryEvent>();
  const responses = new Set<string>();
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event === "api.invoke.request") {
      observed += 1;
      const requestId = stringField(event, "requestId");
      if (!requestId) {
        findings.push(finding("missing-requestid", "api.invoke.request must include requestId", event));
        continue;
      }
      requests.set(requestId, event);
      continue;
    }

    if (event.event === "api.invoke.response") {
      const requestId = stringField(event, "requestId");
      if (!requestId) {
        findings.push(finding("missing-requestid", "api.invoke.response must include requestId", event));
        continue;
      }
      responses.add(requestId);
      if (!requests.has(requestId)) {
        findings.push(
          finding("response-without-request", "api.invoke.response had no matching request", event),
        );
      }
      if (booleanField(event, "ok") === false) {
        const error = stringField(event, "error");
        if (!error || !API_ERRORS.has(error)) {
          findings.push(finding("untyped-api-error", "api.invoke.response used an unknown error", event));
        }
      }
    }
  }

  for (const requestId of requests.keys()) {
    if (!responses.has(requestId)) {
      findings.push(
        finding("request-without-response", "api.invoke.request had no matching response", undefined, {
          requestId,
        }),
      );
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
