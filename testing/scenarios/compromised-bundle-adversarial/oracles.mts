import type { HistoryEvent, Oracle, OracleFinding } from "@pax-backend/oracles-lib";

const compromisedBundleOracle: Oracle = (history) => {
  const findings: OracleFinding[] = [];
  const rejection = history.find(
    (event) => event.event === "ws.send.rejected" && event["error"] === "targetNotConnected",
  );
  if (!rejection) {
    findings.push({
      code: "missing-target-rejection",
      message: "hostile bundle send to a missing player was not rejected",
    });
  } else if (!detailIncludesMissingTarget(rejection, "intruder-player")) {
    findings.push({
      code: "missing-target-detail",
      message: "targetNotConnected rejection must name the missing target",
      event: rejection,
    });
  }

  const maliciousLog = history.find(
    (event) =>
      event.event === "log.emit" &&
      isRecord(event["payload"]) &&
      event["payload"]["event"] === "hostile-ws-target.maliciousSend" &&
      isRecord(event["payload"]["response"]) &&
      event["payload"]["response"]["ok"] === false &&
      event["payload"]["response"]["error"] === "targetNotConnected",
  );
  if (!maliciousLog) {
    findings.push({
      code: "missing-bundle-visible-refusal",
      message: "hostile bundle did not observe the typed targetNotConnected response",
    });
  }

  const leakedSend = history.find(
    (event) => event.event === "ws.send" && event["playerId"] === "intruder-player",
  );
  if (leakedSend) {
    findings.push({
      code: "unexpected-missing-target-send",
      message: "Broker sent a frame to the missing target",
      event: leakedSend,
    });
  }

  const fatal = history.find(
    (event) =>
      event.event === "broker.crash" ||
      event.event === "broker.fatal" ||
      event.event === "isolate.fatal",
  );
  if (fatal) {
    findings.push({
      code: "unexpected-runtime-fatal",
      message: "hostile bundle target attempt caused a runtime fatal event",
      event: fatal,
    });
  }

  return {
    oracle: "compromised-bundle-target-refusal",
    guarantee: 0,
    status: findings.length === 0 ? "pass" : "fail",
    checkedEvents: history.length,
    findings,
  };
};

export default [compromisedBundleOracle];

function detailIncludesMissingTarget(event: HistoryEvent, playerId: string): boolean {
  const detail = event["detail"];
  if (!isRecord(detail)) return false;
  const missingTargets = detail["missingTargets"];
  return Array.isArray(missingTargets) && missingTargets.includes(playerId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
