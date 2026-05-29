import type { HistoryEvent, Oracle, OracleFinding } from "@pax-backend/oracles-lib";

export const oracleNames = [
  "singleton-game",
  "faithful-api-dispatch",
  "compute-plane-quotas",
  "crash-blast-radius",
  "state-durability",
  "blob-durability",
  "history-completeness",
] as const;

const computeEdgeOracle: Oracle = (history) => {
  const findings: OracleFinding[] = [];
  requireEvent(
    history,
    (event) => event.event === "ws.send.rejected" && event["error"] === "rateExceeded",
    "missing-ws-rate-rejection",
    "ws-messages-per-sec edge did not produce rateExceeded",
    findings,
  );
  requireEvent(
    history,
    (event) => event.event === "ws.send.rejected" && event["error"] === "bandwidthExceeded",
    "missing-bandwidth-rejection",
    "bandwidth-bytes-per-sec edge did not produce bandwidthExceeded",
    findings,
  );
  requireEvent(
    history,
    (event) => event.event === "state.write.rejected" && event["error"] === "sizeExceeded",
    "missing-state-size-rejection",
    "state-bytes edge did not produce sizeExceeded",
    findings,
  );
  requireEvent(
    history,
    (event) => event.event === "blob.put.rejected" && event["error"] === "keyCountExceeded",
    "missing-blob-key-rejection",
    "blob-keys edge did not produce keyCountExceeded",
    findings,
  );
  requireEvent(
    history,
    (event) =>
      event.event === "handler.error" &&
      event["handlerName"] === "onPlayerMessage" &&
      event["code"] === "handlerTimeout",
    "missing-cpu-handler-timeout",
    "cpu-ms-per-tick edge did not produce handler.error(handlerTimeout)",
    findings,
  );
  requireEvent(
    history,
    (event) =>
      event.event === "compute.budget.rejected" &&
      event["budget"] === "cpu-ms-per-tick" &&
      event["reason"] === "handlerTimeout",
    "missing-cpu-budget-rejection",
    "cpu-ms-per-tick edge did not produce compute.budget.rejected",
    findings,
  );

  const apiRateExceeded = history.filter(
    (event) =>
      event.event === "api.invoke.response" &&
      event["ok"] === false &&
      event["error"] === "apiRateExceeded",
  );
  if (apiRateExceeded.length === 0) {
    findings.push({
      code: "missing-api-rate-rejection",
      message: "api-invocations-per-min edge did not produce apiRateExceeded",
    });
  }
  const wiresByRequestId = new Map(
    history
      .filter((event) => event.event === "api.invoke.wire" && typeof event["requestId"] === "string")
      .map((event) => [event["requestId"], event]),
  );
  for (const response of apiRateExceeded) {
    const requestId = response["requestId"];
    const wire = typeof requestId === "string" ? wiresByRequestId.get(requestId) : undefined;
    if (wire) {
      findings.push({
        code: "api-rate-contacted-service",
        message: "apiRateExceeded must be rejected before contacting the gateway",
        event: response,
      });
    }
  }

  return {
    oracle: "compute-budget-edges",
    guarantee: 0,
    status: findings.length === 0 ? "pass" : "fail",
    checkedEvents: history.length,
    findings,
  };
};

export default [computeEdgeOracle];

function requireEvent(
  history: readonly HistoryEvent[],
  predicate: (event: HistoryEvent) => boolean,
  code: string,
  message: string,
  findings: OracleFinding[],
): void {
  if (!history.some(predicate)) findings.push({ code, message });
}
