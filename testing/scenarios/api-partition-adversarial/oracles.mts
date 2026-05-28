import type { HistoryEvent, Oracle, OracleFinding } from "@pax-backend/oracles-lib";

export const oracleNames = [
  "faithful-api-dispatch",
  "crash-blast-radius",
  "history-completeness",
] as const;

const apiPartitionOracle: Oracle = (history) => {
  const findings: OracleFinding[] = [];
  const injected = firstEvent(
    history,
    (event) =>
      event.event === "nemesis.api-kind-partition.injected" &&
      event["kindName"] === "mock-ai.v1",
  );
  const restored = firstEvent(
    history,
    (event) =>
      event.event === "nemesis.api-kind-partition.restored" &&
      event["kindName"] === "mock-ai.v1",
  );

  if (!injected) {
    findings.push({
      code: "missing-partition-injection",
      message: "api-kind partition nemesis did not record an injection",
    });
  }
  if (!restored) {
    findings.push({
      code: "missing-partition-restore",
      message: "api-kind partition nemesis did not restore the API-kind registration",
    });
  }

  const partitionStart = eventTime(injected);
  const partitionEnd = eventTime(restored);
  const providerFailures = history.filter(
    (event) =>
      event.event === "api.invoke.response" &&
      event["kind"] === "mock-ai.v1" &&
      event["ok"] === false &&
      event["error"] === "providerError" &&
      event["statusCode"] === 0 &&
      withinWindow(event, partitionStart, partitionEnd),
  );
  if (providerFailures.length === 0) {
    findings.push({
      code: "missing-typed-provider-error",
      message: "partitioned mock-ai.v1 calls did not fail as typed providerError/statusCode=0",
    });
  }

  const recoveredResponses = history.filter(
    (event) =>
      event.event === "api.invoke.response" &&
      event["kind"] === "mock-ai.v1" &&
      event["ok"] === true &&
      after(event, partitionEnd),
  );
  if (recoveredResponses.length === 0) {
    findings.push({
      code: "missing-post-restore-success",
      message: "mock-ai.v1 did not recover to successful responses after partition restoration",
    });
  }

  return {
    oracle: "api-partition-adversarial",
    guarantee: 0,
    status: findings.length === 0 ? "pass" : "fail",
    checkedEvents: history.length,
    findings,
  };
};

export default [apiPartitionOracle];

function firstEvent(
  history: readonly HistoryEvent[],
  predicate: (event: HistoryEvent) => boolean,
): HistoryEvent | undefined {
  return history.find(predicate);
}

function withinWindow(
  event: HistoryEvent,
  start: number | undefined,
  end: number | undefined,
): boolean {
  if (start === undefined || end === undefined) return false;
  const ts = eventTime(event);
  return ts !== undefined && ts >= start && ts <= end;
}

function after(event: HistoryEvent, threshold: number | undefined): boolean {
  if (threshold === undefined) return false;
  const ts = eventTime(event);
  return ts !== undefined && ts > threshold;
}

function eventTime(event: HistoryEvent | undefined): number | undefined {
  if (!event || typeof event.ts !== "string") return undefined;
  const ts = Date.parse(event.ts);
  return Number.isFinite(ts) ? ts : undefined;
}
