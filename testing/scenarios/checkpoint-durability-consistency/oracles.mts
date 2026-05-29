import type { HistoryEvent, Oracle, OracleFinding, OracleResult } from "@pax-backend/oracles-lib";

const ORACLE = "checkpoint-durability-consistency";
const GUARANTEE = 11;

const checkpointOracle: Oracle = (history) => {
  const findings: OracleFinding[] = [];
  const checkpointEvents = history.filter((event) => event.event === "state.checkpoint");
  const plannedFlushes = history.filter((event) => event.event === "state.flush.plannedTransition");
  const runnerCrashes = history.filter((event) => event.event === "runner.crash");
  const checkpointSkipped = history.some(
    (event) =>
      event.event === "nemesis.await.skipped" &&
      event["action"] === "crash-runner",
  );
  const logs = history.flatMap((event) => {
    const payload = payloadRecord(event);
    const name = typeof payload?.["event"] === "string" ? payload["event"] : undefined;
    return name?.startsWith("checkpoint-skew.") ? [{ event, payload, name }] : [];
  });

  for (const log of logs) {
    if (log.payload["skew"] === true) {
      findings.push({
        code: "state-blob-skew",
        message: "checkpoint-skew probe observed different state/blob markers",
        event: log.event,
        detail: markerDetail(log.payload),
      });
    }
  }

  requireLog(logs, "checkpoint-skew.commit", "committed", findings);
  requireLog(logs, "checkpoint-skew.dirty", "interval", findings);
  requireLog(logs, "checkpoint-skew.dirty", "planned", findings);

  if (!checkpointEvents.some((event) => event["trigger"] === "interval")) {
    findings.push({
      code: "missing-interval-checkpoint",
      message: "dirty state/blob writes did not produce a state.checkpoint interval flush",
    });
  }
  if (plannedFlushes.length === 0) {
    findings.push({
      code: "missing-planned-transition-flush",
      message: "planned eviction did not produce state.flush.plannedTransition",
    });
  }

  requireProbeMarker(logs, "after-interval-crash", "interval", findings);
  requireProbeMarker(logs, "after-planned-evict", "planned", findings);

  if (runnerCrashes.length > 0) {
    requireLog(logs, "checkpoint-skew.dirty", "volatile", findings);
    requireProbeMarker(logs, "after-unplanned-crash", "interval", findings);
  } else if (!checkpointSkipped) {
    findings.push({
      code: "missing-runner-crash-or-skip",
      message: "scenario neither observed runner.crash nor a skipped crash-runner await",
    });
  }

  return {
    oracle: ORACLE,
    guarantee: GUARANTEE,
    status: findings.length === 0 ? "pass" : "fail",
    checkedEvents: history.length,
    findings,
  } satisfies OracleResult;
};

export default [checkpointOracle];

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
      code: "unexpected-probe-marker",
      message: `checkpoint probe ${probeMarker} did not restore the expected marker`,
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

function markerDetail(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    marker: payload["marker"],
    stateMarker: payload["stateMarker"],
    blobMarker: payload["blobMarker"],
    state: payload["state"],
    blob: payload["blob"],
  };
}
