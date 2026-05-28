import { finding, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "allowed-only-connection";
const GUARANTEE = 2;

export function allowedOnlyConnection(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];
  const forced = new Set<string>();
  const closed = new Set<string>();
  let observed = 0;

  for (const event of history) {
    if (event.event === "session.opened") {
      observed += 1;
      for (const field of ["gameId", "sessionId", "playerId"]) {
        if (!stringField(event, field)) {
          findings.push(
            finding("missing-field", `session.opened must include ${field}`, event, { field }),
          );
        }
      }
      continue;
    }

    if (event.event === "connection.refused") {
      observed += 1;
      if (stringField(event, "reason") !== "notAllowed") {
        findings.push(
          finding("unexpected-refusal-reason", "connection.refused used an unexpected reason", event),
        );
      }
      continue;
    }

    if (event.event === "session.forceDisconnect") {
      observed += 1;
      const sessionId = stringField(event, "sessionId");
      if (stringField(event, "reason") === "removedFromAllowedPlayers" && sessionId) {
        forced.add(sessionId);
      }
      continue;
    }

    if (event.event === "session.closed") {
      const sessionId = stringField(event, "sessionId");
      if (sessionId && stringField(event, "reason") === "removedFromAllowedPlayers") {
        closed.add(sessionId);
      }
    }
  }

  for (const sessionId of forced) {
    if (!closed.has(sessionId)) {
      findings.push(
        finding(
          "forced-session-not-closed",
          "removed player was force-disconnected but no matching session.closed was recorded",
          undefined,
          { sessionId },
        ),
      );
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
