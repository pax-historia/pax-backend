import { finding, requiredStringFindings, result } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "history-completeness";
const GUARANTEE = 14;

const REQUIRED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "api.invoke.request": ["actorId", "gameId", "requestId", "kind"],
  "api.invoke.response": ["actorId", "gameId", "requestId", "kind"],
  "blob.read": ["actorId", "gameId", "requestId"],
  "blob.write": ["actorId", "gameId", "requestId"],
  "compute.budget": ["actorId", "gameId", "requestId"],
  "log.emit": ["actorId", "gameId", "runId"],
  "metrics.emit": ["actorId", "gameId", "runId"],
  "onPlayerMessage": ["actorId", "gameId", "sessionId", "playerId"],
  "onWake.sent": ["actorId", "gameId", "runId"],
  "players.allowed": ["actorId", "gameId", "requestId"],
  "players.connected": ["actorId", "gameId", "requestId"],
  "session.closed": ["actorId", "gameId", "sessionId", "playerId"],
  "session.opened": ["actorId", "gameId", "sessionId", "playerId"],
  "state.flush": ["actorId", "gameId", "requestId"],
  "state.read": ["actorId", "gameId", "requestId"],
  "state.write": ["actorId", "gameId", "requestId"],
  "ws.send": ["actorId", "gameId", "runId"],
};

export function historyCompleteness(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];

  for (const event of history) {
    if (typeof event.ts !== "string" || Number.isNaN(Date.parse(event.ts))) {
      findings.push(finding("missing-ts", "history event must include an ISO timestamp", event));
    }
    if (typeof event.shardId !== "string" || event.shardId.length === 0) {
      findings.push(finding("missing-shardid", "history event must include shardId", event));
    }
    const required = REQUIRED_FIELDS[event.event] ?? [];
    findings.push(...requiredStringFindings(event, required));
  }

  return result(ORACLE, GUARANTEE, history, history.length, findings);
}
