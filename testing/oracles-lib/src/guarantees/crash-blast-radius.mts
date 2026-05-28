import { booleanField, finding, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "crash-blast-radius";
const GUARANTEE = 8;

export function crashBlastRadius(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];
  const pendingRestarts = new Map<string, HistoryEvent>();
  let observed = 0;

  for (const event of history) {
    if (event.event === "child.restart.failed") {
      observed += 1;
      findings.push(
        finding(
          "child-restart-failed",
          "unexpected child exits must restart the same game successfully",
          event,
        ),
      );
      continue;
    }

    if (event.event === "child.restart") {
      observed += 1;
      const actorId = stringField(event, "actorId");
      const gameId = stringField(event, "gameId");
      if (!actorId || !gameId || stringField(event, "reason") !== "cold-restart-after-crash") {
        findings.push(
          finding(
            "unscoped-child-restart",
            "child.restart must be scoped and use cold-restart-after-crash",
            event,
          ),
        );
        continue;
      }
      pendingRestarts.delete(`${actorId}:${gameId}`);
      continue;
    }

    if (event.event !== "child.exit" && event.event !== "child.fatal") continue;
    observed += 1;
    const actorId = stringField(event, "actorId");
    const gameId = stringField(event, "gameId");
    if (!gameId || !actorId) {
      findings.push(
        finding("unscoped-child-failure", "child failure event must be scoped to one actor and game", event),
      );
      continue;
    }
    if (event.event === "child.exit" && booleanField(event, "intentional") === true) {
      continue;
    }
    if (event.event === "child.exit") {
      pendingRestarts.set(`${actorId}:${gameId}`, event);
    }
  }

  for (const event of pendingRestarts.values()) {
    findings.push(
      finding(
        "missing-child-restart",
        "unexpected child.exit must be followed by a child.restart for the same game",
        event,
      ),
    );
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
