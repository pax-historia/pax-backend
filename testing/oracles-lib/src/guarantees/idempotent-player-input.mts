import { finding, numberField, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "idempotent-player-input";
const GUARANTEE = 6;

export function idempotentPlayerInput(history: readonly HistoryEvent[]): OracleResult {
  const delivered = new Set<string>();
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event !== "onPlayerMessage") continue;
    observed += 1;
    const gameId = stringField(event, "gameId");
    const playerId = stringField(event, "playerId");
    const seq = numberField(event, "seq");
    if (!gameId || !playerId || seq === undefined) {
      findings.push(
        finding("missing-input-identity", "onPlayerMessage must include gameId, playerId, and seq", event),
      );
      continue;
    }
    const key = `${gameId}:${playerId}:${seq}`;
    if (delivered.has(key)) {
      findings.push(
        finding("duplicate-player-input", "same (gameId, playerId, seq) delivered twice", event, {
          gameId,
          playerId,
          seq,
        }),
      );
    }
    delivered.add(key);
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
