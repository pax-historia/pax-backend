import { finding, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "singleton-game";
const GUARANTEE = 1;

export function singletonGame(history: readonly HistoryEvent[]): OracleResult {
  const activeRunByGame = new Map<string, string>();
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event === "game.created" || event.event === "game.woke" || event.event === "isolate.created") {
      observed += 1;
      const gameId = stringField(event, "gameId");
      const runId =
        stringField(event, "runId") ??
        numberScope(event, "generation") ??
        stringField(event, "runnerId") ??
        stringField(event, "runnerName") ??
        event.event;
      if (!gameId || !runId) {
        findings.push(finding("missing-field", `${event.event} must include gameId and a run scope`, event));
        continue;
      }
      const activeRun = activeRunByGame.get(gameId);
      if (activeRun && activeRun !== runId) {
        findings.push(
          finding(
            "concurrent-game-run",
            "a second run started before the first run ended",
            event,
            { gameId, activeRun, newRun: runId },
          ),
        );
      }
      activeRunByGame.set(gameId, runId);
      continue;
    }

    if (
      event.event === "child.exit" ||
      event.event === "actor.stop" ||
      event.event === "game.released" ||
      event.event === "isolate.disposed"
    ) {
      const gameId = stringField(event, "gameId");
      if (gameId) activeRunByGame.delete(gameId);
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}

function numberScope(event: HistoryEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}
