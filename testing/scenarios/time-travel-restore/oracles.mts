import type { HistoryEvent, Oracle, OracleFinding, OracleResult } from "@pax-backend/oracles-lib";

const ORACLE = "time-travel-restore";
const GUARANTEE = 11;

const timeTravelRestoreOracle: Oracle = (history) => {
  const findings: OracleFinding[] = [];
  const logs = history.flatMap((event) => {
    const payload = payloadRecord(event);
    const name = typeof payload?.["event"] === "string" ? payload["event"] : undefined;
    return name?.startsWith("checkpoint-skew.") ? [{ event, payload, name }] : [];
  });

  requireSnapshot(history, "first", "first", findings);
  requireSnapshot(history, null, "second", findings);
  const restore = history.find((event) => event.event === "state.restore");
  if (!restore) {
    findings.push({
      code: "missing-state-restore",
      message: "admin restore did not emit state.restore",
    });
  } else {
    const from = numberField(restore, "fromCheckpointSeq");
    const to = numberField(restore, "newCheckpointSeq");
    if (from === undefined || to === undefined || to <= from) {
      findings.push({
        code: "restore-not-forward",
        message: "state.restore must advance head with a new checkpoint sequence",
        event: restore,
        detail: { from, to },
      });
    }
  }
  requireEvent(
    history,
    (event) => event.event === "isolate.restart" && event["cause"] === "stateRestore",
    "missing-restore-restart",
    "active game was not restarted from storage after restore",
    findings,
  );
  requireProbeMarker(logs, "after-restore", "first", findings);

  return {
    oracle: ORACLE,
    guarantee: GUARANTEE,
    status: findings.length === 0 ? "pass" : "fail",
    checkedEvents: history.length,
    findings,
  } satisfies OracleResult;
};

export default [timeTravelRestoreOracle];

function requireSnapshot(
  history: readonly HistoryEvent[],
  checkpointAlias: string | null,
  marker: string,
  findings: OracleFinding[],
): void {
  const event = history.find(
    (candidate) =>
      candidate.event === "workload.admin-snapshot.observed" &&
      candidate["checkpointAlias"] === checkpointAlias &&
      candidate["stateMarker"] === marker &&
      candidate["blobMarker"] === marker,
  );
  if (event) return;
  findings.push({
    code: "missing-admin-snapshot",
    message: `admin snapshot did not observe marker ${marker}`,
    detail: { checkpointAlias, marker },
  });
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
      code: "restore-materialized-wrong-root",
      message: "post-restore wake did not materialize the restored root",
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

function numberField(record: Readonly<Record<string, unknown>>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" ? value : undefined;
}
