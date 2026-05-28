import type { HistoryEvent, Oracle, OracleFinding } from "@pax-backend/oracles-lib";

export const oracleNames = [
  "singleton-game",
  "allowed-only-connection",
  "unique-stable-sessionid",
  "bundle-compatibility-safety",
  "migration-rollback-safety",
  "placement-contract-safety",
  "host-event-durability",
  "state-durability",
  "blob-durability",
  "crash-blast-radius",
  "history-completeness",
] as const;

const raceDeployOracle: Oracle = (history) => {
  const findings: OracleFinding[] = [];
  requireEvent(
    history,
    (event) =>
      event.event === "bundle.flip.succeeded" &&
      event["oldBundleName"] === "race-edge-probe-v1" &&
      event["newBundleName"] === "race-edge-probe-v2",
    "missing-active-bundle-flip",
    "active v1->v2 bundle flip did not succeed",
    findings,
  );
  requireEvent(
    history,
    (event) =>
      event.event === "onWake.sent" &&
      event["bundleName"] === "race-edge-probe-v2" &&
      event["bundleCompatTag"] === "race-edge:v2" &&
      event["blobCompatTag"] === "race-edge:v1",
    "missing-upgrade-wake",
    "post-sleep wake did not load v2 against the v1 blob compat tag",
    findings,
  );
  requireEvent(
    history,
    (event) =>
      event.event === "log.emit" &&
      payloadField(event, "event") === "race-edge-probe.onHostEvent" &&
      payloadField(event, "bundleName") === "race-edge-probe-v2" &&
      payloadField(event, "eventType") === "race.afterSleep",
    "missing-v2-host-event",
    "wakeOnDelivery host event after sleep was not handled by v2",
    findings,
  );
  requireEvent(
    history,
    (event) => event.event === "lifecycle.sleepGrace.cancelled",
    "missing-sleep-grace-cancel",
    "reconnect churn did not cancel an idle sleep grace window",
    findings,
  );
  requireMinimum(
    history,
    (event) => event.event === "session.opened",
    4,
    "missing-connect-churn",
    "scenario did not open enough sessions to exercise reconnect churn",
    findings,
  );
  requireMinimum(
    history,
    (event) => event.event === "session.closed",
    3,
    "missing-disconnect-churn",
    "scenario did not close enough sessions to exercise disconnect churn",
    findings,
  );

  return {
    oracle: "race-and-deploy-adversarial",
    guarantee: 0,
    status: findings.length === 0 ? "pass" : "fail",
    checkedEvents: history.length,
    findings,
  };
};

export default [raceDeployOracle];

function requireEvent(
  history: readonly HistoryEvent[],
  predicate: (event: HistoryEvent) => boolean,
  code: string,
  message: string,
  findings: OracleFinding[],
): void {
  if (!history.some(predicate)) findings.push({ code, message });
}

function requireMinimum(
  history: readonly HistoryEvent[],
  predicate: (event: HistoryEvent) => boolean,
  minimum: number,
  code: string,
  message: string,
  findings: OracleFinding[],
): void {
  const count = history.filter(predicate).length;
  if (count < minimum) findings.push({ code, message, detail: { minimum, count } });
}

function payloadField(event: HistoryEvent, field: string): unknown {
  const payload = event["payload"];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return (payload as Record<string, unknown>)[field];
}
