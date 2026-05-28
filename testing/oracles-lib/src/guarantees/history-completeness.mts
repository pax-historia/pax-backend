import { finding, requiredStringFindings, result } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "history-completeness";
const GUARANTEE = 14;

const REQUIRED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "api.invoke.request": ["actorId", "gameId", "requestId", "kind"],
  "api.invoke.response": ["actorId", "gameId", "requestId", "kind"],
  "api.invoke.wire": [
    "actorId",
    "gameId",
    "requestId",
    "gatewayRequestId",
    "kind",
    "runId",
    "fingerprint",
    "rawOutbound",
    "rawInbound",
  ],
  "blob.read": ["actorId", "gameId", "requestId"],
  "blob.write": ["actorId", "gameId", "requestId"],
  "child.exit": ["actorId", "gameId", "runId"],
  "child.fatal": ["actorId", "gameId"],
  "child.handlerComplete": ["actorId", "gameId", "runId", "handler"],
  "child.handlerError": ["actorId", "gameId", "runId", "handler", "code"],
  "compute.budget.rejected": ["actorId", "gameId", "reason"],
  "bundle.flip.rejected": ["gameId", "oldBundleName", "newBundleName", "blobCompatTag"],
  "bundle.flip.succeeded": ["gameId", "oldBundleName", "newBundleName"],
  "bundle.coldWake.rejected": ["actorId", "gameId", "bundleName", "blobCompatTag"],
  "bundle.loaded": ["actorId", "gameId", "bundleName", "bundleCompatTag"],
  "compute.budget": ["actorId", "gameId", "requestId"],
  "game.deleted": ["gameId"],
  "log.emit": ["actorId", "gameId", "runId"],
  "lifecycle.sleepComplete": ["actorId", "gameId", "runId", "blobCompatTag"],
  "metrics.emit": ["actorId", "gameId", "runId"],
  "onPlayerMessage": ["actorId", "gameId", "sessionId", "playerId", "traceId"],
  "onWake.sent": ["actorId", "gameId", "runId", "bundleCompatTag"],
  "placement.accepted": ["gameId", "placedShardId", "runId", "traceId", "bundleName"],
  "placement.rejected": ["gameId", "error"],
  "player.deleted": ["playerId"],
  "players.allowed": ["actorId", "gameId", "requestId"],
  "players.connected": ["actorId", "gameId", "requestId"],
  "session.closed": ["actorId", "gameId", "sessionId", "playerId", "traceId"],
  "session.opened": ["actorId", "gameId", "sessionId", "playerId", "traceId"],
  "state.flush": ["actorId", "gameId", "requestId"],
  "state.read": ["actorId", "gameId", "requestId"],
  "state.write": ["actorId", "gameId", "requestId"],
  "ws.send": ["actorId", "gameId", "runId"],
  "ws.send.rejected": ["actorId", "gameId", "runId", "error"],
};

export function historyCompleteness(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];
  const lastSeqByShard = new Map<string, number>();

  for (const event of history) {
    if (typeof event.ts !== "string" || Number.isNaN(Date.parse(event.ts))) {
      findings.push(finding("missing-ts", "history event must include an ISO timestamp", event));
    }
    if (typeof event.shardId !== "string" || event.shardId.length === 0) {
      findings.push(finding("missing-shardid", "history event must include shardId", event));
    }
    const paxSeq = event.pax_seq;
    if (typeof paxSeq !== "number" || !Number.isInteger(paxSeq) || paxSeq < 1) {
      findings.push(finding("missing-pax-seq", "history event must include positive pax_seq", event));
    } else if (typeof event.shardId === "string" && event.shardId.length > 0) {
      const previous = lastSeqByShard.get(event.shardId);
      if (previous !== undefined && paxSeq !== previous + 1) {
        findings.push(
          finding("pax-seq-gap", "history pax_seq must be contiguous per shard", event, {
            previous,
            expected: previous + 1,
            actual: paxSeq,
          }),
        );
      }
      lastSeqByShard.set(event.shardId, paxSeq);
    }
    const required = REQUIRED_FIELDS[event.event] ?? [];
    findings.push(...requiredStringFindings(event, required));
  }

  return result(ORACLE, GUARANTEE, history, history.length, findings);
}
