import { finding, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "unique-stable-sessionid";
const GUARANTEE = 3;

interface SessionIdentity {
  readonly gameId: string;
  readonly playerId: string;
}

export function uniqueStableSessionId(history: readonly HistoryEvent[]): OracleResult {
  const opened = new Map<string, SessionIdentity>();
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event === "session.opened") {
      observed += 1;
      const sessionId = stringField(event, "sessionId");
      const gameId = stringField(event, "gameId");
      const playerId = stringField(event, "playerId");
      if (!sessionId || !gameId || !playerId) {
        findings.push(
          finding("missing-field", "session.opened must include sessionId, gameId, and playerId", event),
        );
        continue;
      }
      if (opened.has(sessionId)) {
        findings.push(
          finding("duplicate-sessionid", "sessionId opened more than once", event, { sessionId }),
        );
      }
      opened.set(sessionId, { gameId, playerId });
      continue;
    }

    if (
      event.event === "onPlayerMessage" ||
      event.event === "session.closed" ||
      event.event === "ws.send" ||
      event.event === "api.invoke.request"
    ) {
      const sessionId = stringField(event, "sessionId") ?? stringField(event, "triggeringSessionId");
      if (!sessionId) continue;
      const identity = opened.get(sessionId);
      if (!identity) {
        findings.push(
          finding("unknown-sessionid", "event referenced a sessionId that was never opened", event, {
            sessionId,
          }),
        );
        continue;
      }
      const gameId = stringField(event, "gameId");
      const playerId = stringField(event, "playerId");
      if (gameId && gameId !== identity.gameId) {
        findings.push(finding("session-game-drift", "sessionId changed game identity", event));
      }
      if (playerId && playerId !== identity.playerId) {
        findings.push(finding("session-player-drift", "sessionId changed player identity", event));
      }
    }
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
