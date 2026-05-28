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
  const partitionExpected = expectsPartition(history) || !!injected || !!restored;

  if (!partitionExpected) {
    requireEvent(
      history,
      (event) =>
        event.event === "api.invoke.response" &&
        event["kind"] === "mock-ai.v1" &&
        event["ok"] === true,
      "missing-baseline-api-success",
      "non-partition nemesis run did not produce a successful mock-ai.v1 response",
      findings,
    );
    rejectEvent(
      history,
      (event) =>
        event.event === "api.invoke.response" &&
        event["kind"] === "mock-ai.v1" &&
        event["ok"] === false &&
        event["error"] === "providerError",
      "unexpected-provider-error",
      "non-partition nemesis run produced providerError for mock-ai.v1",
      findings,
    );
    return buildResult(history, findings);
  }

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

  return buildResult(history, findings);
};

export default [apiPartitionOracle];

function firstEvent(
  history: readonly HistoryEvent[],
  predicate: (event: HistoryEvent) => boolean,
): HistoryEvent | undefined {
  return history.find(predicate);
}

function expectsPartition(history: readonly HistoryEvent[]): boolean {
  const profile = firstEvent(history, (event) => event.event === "nemesis.profile.started");
  const actionTypes = profile?.["actionTypes"];
  return (
    Array.isArray(actionTypes) &&
    actionTypes.some((actionType) => actionType === "api-kind-partition")
  );
}

function requireEvent(
  history: readonly HistoryEvent[],
  predicate: (event: HistoryEvent) => boolean,
  code: string,
  message: string,
  findings: OracleFinding[],
): void {
  if (!history.some(predicate)) findings.push({ code, message });
}

function rejectEvent(
  history: readonly HistoryEvent[],
  predicate: (event: HistoryEvent) => boolean,
  code: string,
  message: string,
  findings: OracleFinding[],
): void {
  const event = history.find(predicate);
  if (event) findings.push({ code, message, event });
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

function buildResult(history: readonly HistoryEvent[], findings: readonly OracleFinding[]) {
  return {
    oracle: "api-partition-adversarial",
    guarantee: 0,
    status: findings.length === 0 ? "pass" : "fail",
    checkedEvents: history.length,
    findings,
  } as const;
}
