import { booleanField, finding, numberField, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "crash-blast-radius";
const GUARANTEE = 8;

export function crashBlastRadius(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];
  const pendingRestarts = new Map<string, HistoryEvent>();
  let observed = 0;

  for (const event of history) {
    if (event.event === "isolate.restart.failed") {
      observed += 1;
      findings.push(
        finding(
          "isolate-restart-failed",
          "unexpected isolate failures must restart the same game successfully",
          event,
        ),
      );
      continue;
    }

    if (event.event === "isolate.restart") {
      observed += 1;
      const gameId = stringField(event, "gameId");
      if (!gameId) {
        findings.push(
          finding("unscoped-isolate-restart", "isolate.restart must be scoped to one game", event),
        );
        continue;
      }
      pendingRestarts.delete(`broker:${gameId}`);
      continue;
    }

    if (event.event === "isolate.disposed" || event.event === "isolate.fatal") {
      observed += 1;
      const gameId = stringField(event, "gameId");
      if (!gameId) {
        findings.push(
          finding("unscoped-isolate-failure", "isolate failure event must be scoped to one game", event),
        );
        continue;
      }
      if (event.event === "isolate.disposed" && booleanField(event, "intentional") === true) {
        continue;
      }
      pendingRestarts.set(`broker:${gameId}`, event);
      continue;
    }

    if (event.event === "runner.crash") {
      observed += 1;
      const affected = event["affectedGameIds"];
      if (!Array.isArray(affected)) {
        findings.push(
          finding("unscoped-runner-crash", "runner.crash must include affectedGameIds", event),
        );
        continue;
      }
      const maxAssignedGames = numberField(event, "maxAssignedGames");
      if (
        maxAssignedGames !== undefined &&
        Number.isInteger(maxAssignedGames) &&
        maxAssignedGames > 0 &&
        affected.length > maxAssignedGames
      ) {
        findings.push(
          finding(
            "runner-crash-exceeds-k",
            "runner.crash affected more games than the Runner K bound",
            event,
            { affected: affected.length, maxAssignedGames },
          ),
        );
      }
      for (const gameId of affected) {
        if (typeof gameId === "string" && gameId.length > 0) {
          pendingRestarts.set(`broker:${gameId}`, event);
        }
      }
      continue;
    }

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
        "missing-isolate-restart",
        "unexpected isolate or runner failure must be followed by an isolate.restart for the same game",
        event,
      ),
    );
  }

  return result(ORACLE, GUARANTEE, history, Math.max(observed, history.length), findings);
}
