import type { HistoryEvent, Oracle, OracleFinding } from "@pax-backend/oracles-lib";

const jwtRefusalOracle: Oracle = (history) => {
  const findings: OracleFinding[] = [];
  const refusals = history.filter((event) => event.event === "workload.ws-refusal.observed");
  const wrongGame = refusals.find(
    (event) =>
      event["tokenMutation"] === "none" && event["placementGameId"] !== event["connectGameId"],
  );
  if (!wrongGame) {
    findings.push({ code: "missing-wrong-game-refusal", message: "wrong-game JWT was not attempted" });
  } else {
    requireObservedCode(wrongGame, [4403, 1011], findings);
  }
  const opened = history.filter((event) => event.event === "session.opened");
  if (opened.length > 0) {
    findings.push({
      code: "unexpected-session-opened",
      message: "adversarial JWT attempts must not open a session",
      event: opened[0],
    });
  }
  const wrongGameRefusal = history.find(
    (event) => event.event === "connection.refused" && event["reason"] === "wrongGame",
  );
  if (!wrongGameRefusal) {
    findings.push({
      code: "missing-wrong-game-history",
      message: "wrong-game JWT refusal must be recorded to history",
    });
  }
  return {
    oracle: "jwt-adversarial-refusals",
    guarantee: 0,
    status: findings.length === 0 ? "pass" : "fail",
    checkedEvents: history.length,
    findings,
  };
};

export default [jwtRefusalOracle];

function requireObservedCode(
  event: HistoryEvent,
  codes: readonly number[],
  findings: OracleFinding[],
): void {
  if (typeof event["observedCode"] !== "number" || !codes.includes(event["observedCode"])) {
    findings.push({
      code: "unexpected-close-code",
      message: `expected close code ${codes.join(" or ")}`,
      event,
    });
  }
}
