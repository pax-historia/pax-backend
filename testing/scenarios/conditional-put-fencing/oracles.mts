import type { HistoryEvent, Oracle, OracleFinding, OracleResult } from "@pax-backend/oracles-lib";

const ORACLE = "conditional-put-fencing";
const GUARANTEE = 11;

const conditionalPutFencingOracle: Oracle = (history) => {
  const findings: OracleFinding[] = [];
  const logs = history.flatMap((event) => {
    const payload = payloadRecord(event);
    const name = typeof payload?.["event"] === "string" ? payload["event"] : undefined;
    return name?.startsWith("checkpoint-skew.") ? [{ event, payload, name }] : [];
  });

  requireEvent(
    history,
    (event) => event.event === "state.fence.winner" && event["marker"] === "winner",
    "missing-fence-winner",
    "scenario did not advance the winning root",
    findings,
  );
  requireEvent(
    history,
    (event) => event.event === "state.fence.conflict" && event["operation"] === "state.flush",
    "missing-fence-conflict",
    "stale owner did not hit the conditional root PUT conflict",
    findings,
  );
  requireEvent(
    history,
    (event) =>
      event.event === "game.stoodDown" &&
      event["reason"] === "supersededByCheckpointConflict",
    "missing-standdown",
    "stale owner did not stand down after the fence conflict",
    findings,
  );
  requireLog(logs, "checkpoint-skew.dirty", "stale", findings);
  requireProbeMarker(logs, "after-fence-conflict", "winner", findings);

  return {
    oracle: ORACLE,
    guarantee: GUARANTEE,
    status: findings.length === 0 ? "pass" : "fail",
    checkedEvents: history.length,
    findings,
  } satisfies OracleResult;
};

export default [conditionalPutFencingOracle];

function requireEvent(
  history: readonly HistoryEvent[],
  predicate: (event: HistoryEvent) => boolean,
  code: string,
  message: string,
  findings: OracleFinding[],
): void {
  if (!history.some(predicate)) findings.push({ code, message });
}

function requireLog(
  logs: readonly {
    readonly event: HistoryEvent;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly name: string;
  }[],
  name: string,
  marker: string,
  findings: OracleFinding[],
): void {
  if (logs.some((log) => log.name === name && log.payload["marker"] === marker)) return;
  findings.push({
    code: "missing-log",
    message: `${name} with marker ${marker} was not observed`,
    detail: { name, marker },
  });
}

function requireProbeMarker(
  logs: readonly {
    readonly event: HistoryEvent;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly name: string;
  }[],
  probeMarker: string,
  expectedMarker: string,
  findings: OracleFinding[],
): void {
  const probe = logs.find(
    (log) =>
      log.name === "checkpoint-skew.probe" &&
      log.payload["marker"] === probeMarker,
  );
  if (!probe) {
    findings.push({
      code: "missing-probe",
      message: `checkpoint probe ${probeMarker} was not observed`,
      detail: { probeMarker },
    });
    return;
  }
  const stateMarker = stringField(probe.payload, "stateMarker");
  const blobMarker = stringField(probe.payload, "blobMarker");
  if (stateMarker !== expectedMarker || blobMarker !== expectedMarker) {
    findings.push({
      code: "stale-root-won",
      message: "post-conflict wake did not materialize the winning root",
      event: probe.event,
      detail: { expectedMarker, stateMarker, blobMarker },
    });
  }
}

function payloadRecord(event: HistoryEvent): Readonly<Record<string, unknown>> | undefined {
  const payload = event["payload"];
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Readonly<Record<string, unknown>>
    : undefined;
}

function stringField(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
