import type { HistoryEvent, Oracle, OracleFinding } from "@pax-backend/oracles-lib";

const runnerCrashOracle: Oracle = (history) => {
  const findings: OracleFinding[] = [];
  const gameIdsInSlice = historyGameIds(history);
  const crash = history.find((event) => event.event === "runner.crash");
  if (!crash) {
    findings.push({
      code: "missing-runner-crash",
      message: "runner-crash nemesis did not produce a runner.crash event",
    });
  } else {
    const affected = crash["affectedGameIds"];
    const maxAssignedGames = crash["maxAssignedGames"];
    if (!Array.isArray(affected) || affected.length === 0) {
      findings.push({
        code: "missing-affected-games",
        message: "runner.crash did not report affected game IDs",
      });
    }
    if (
      typeof maxAssignedGames === "number" &&
      Number.isInteger(maxAssignedGames) &&
      maxAssignedGames > 0 &&
      Array.isArray(affected) &&
      affected.length > maxAssignedGames
    ) {
      findings.push({
        code: "affected-exceeds-k",
        message: "runner.crash affected more games than maxAssignedGames",
        detail: { affected: affected.length, maxAssignedGames },
      });
    }
    for (const gameId of Array.isArray(affected) ? affected : []) {
      if (typeof gameId !== "string") continue;
      if (gameIdsInSlice.size > 0 && !gameIdsInSlice.has(gameId)) continue;
      if (!history.some((event) => event.event === "isolate.restart" && event["gameId"] === gameId)) {
        findings.push({
          code: "missing-restart",
          message: "affected game did not record isolate.restart",
          detail: { gameId },
        });
      }
    }
  }

  requireEvent(
    history,
    (event) => event.event === "nemesis.runner-crash.injected",
    "missing-nemesis-injection",
    "scenario did not record the runner-crash nemesis injection",
    findings,
  );

  return {
    oracle: "runner-crash-blast-radius",
    guarantee: 0,
    status: findings.length === 0 ? "pass" : "fail",
    checkedEvents: history.length,
    findings,
  };
};

export default [runnerCrashOracle];

function requireEvent(
  history: readonly HistoryEvent[],
  predicate: (event: HistoryEvent) => boolean,
  code: string,
  message: string,
  findings: OracleFinding[],
): void {
  if (!history.some(predicate)) findings.push({ code, message });
}

function historyGameIds(history: readonly HistoryEvent[]): ReadonlySet<string> {
  return new Set(
    history.flatMap((event) => {
      const gameId = event["gameId"];
      return typeof gameId === "string" && gameId.length > 0 ? [gameId] : [];
    }),
  );
}
