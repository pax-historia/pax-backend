import { finding, numberField, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "session-observability-accuracy";
const GUARANTEE = 4;

export function sessionObservabilityAccuracy(history: readonly HistoryEvent[]): OracleResult {
  const activeByGame = new Map<string, Set<string>>();
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event === "session.opened") {
      const gameId = stringField(event, "gameId");
      const sessionId = stringField(event, "sessionId");
      if (gameId && sessionId) {
        const active = activeByGame.get(gameId) ?? new Set<string>();
        active.add(sessionId);
        activeByGame.set(gameId, active);
      }
      continue;
    }

    if (event.event === "session.closed") {
      const gameId = stringField(event, "gameId");
      const sessionId = stringField(event, "sessionId");
      if (gameId && sessionId) activeByGame.get(gameId)?.delete(sessionId);
      continue;
    }

    if (event.event === "api.invoke.request") {
      observed += 1;
      const gameId = stringField(event, "gameId");
      const connectedSessionCount = numberField(event, "connectedSessionCount");
      if (!gameId || connectedSessionCount === undefined) {
        findings.push(
          finding(
            "missing-api-context-count",
            "api.invoke.request must include gameId and connectedSessionCount",
            event,
          ),
        );
        continue;
      }
      const expected = activeByGame.get(gameId)?.size ?? 0;
      if (connectedSessionCount !== expected) {
        findings.push(
          finding(
            "connected-session-count-mismatch",
            "api.invoke connectedSessionCount did not match modeled active sessions",
            event,
            { expected, actual: connectedSessionCount },
          ),
        );
      }
    }
  }

  return result(ORACLE, GUARANTEE, history, Math.max(observed, history.length), findings);
}
