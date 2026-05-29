import { finding, requiredStringFindings, result } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "history-completeness";
const GUARANTEE = 14;

const REQUIRED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "api.invoke.error": ["gameId", "requestId", "kind", "error"],
  "api.invoke.request": ["gameId", "requestId", "kind"],
  "api.invoke.response": ["gameId", "requestId", "kind"],
  "api.invoke.wire": ["gameId", "requestId", "gatewayRequestId", "kind", "fingerprint", "rawOutbound", "rawInbound"],
  "blob.delete": ["gameId", "requestId"],
  "blob.get": ["gameId", "requestId"],
  "blob.list": ["gameId", "requestId"],
  "blob.put": ["gameId", "requestId"],
  "blob.put.rejected": ["gameId", "error"],
  "broker.drain.cancelled": ["reason"],
  "broker.drain.completed": ["reason"],
  "broker.drain.started": ["reason"],
  "broker.stop": ["reason"],
  "child.exit": ["actorId", "gameId", "runId"],
  "child.fatal": ["actorId", "gameId"],
  "child.handlerComplete": ["actorId", "gameId", "runId", "handler"],
  "child.handlerError": ["actorId", "gameId", "runId", "handler", "code"],
  "child.restart": ["actorId", "gameId", "runId", "reason", "bundleName"],
  "child.restart.failed": ["actorId", "gameId", "runId", "reason", "bundleName", "error"],
  "compute.budget": ["gameId", "requestId"],
  "compute.budget.rejected": ["gameId", "budget"],
  "bundle.flip.rejected": ["gameId", "oldBundleName", "newBundleName", "blobCompatTag"],
  "bundle.flip.succeeded": ["gameId", "oldBundleName", "newBundleName"],
  "bundle.coldWake.rejected": ["actorId", "gameId", "bundleName", "blobCompatTag"],
  "bundle.loaded": ["actorId", "gameId", "bundleName", "bundleCompatTag"],
  "bundle.rollback": ["actorId", "gameId", "runId", "bundleName", "failedBundleName"],
  "bundle.rollback.error": ["actorId", "gameId", "runId", "bundleName", "error"],
  "bundle.rollback.expired": ["actorId", "gameId", "runId", "bundleName", "failedBundleName"],
  "bundle.rollback.failureCountReset": [
    "actorId",
    "gameId",
    "runId",
    "bundleName",
    "failedBundleName",
  ],
  "bundle.rollback.pending": ["actorId", "gameId", "runId", "bundleName", "failedBundleName"],
  "bundle.rollback.rejected": ["actorId", "gameId", "runId", "bundleName", "failedBundleName"],
  "bundle.rollback.restart": ["actorId", "gameId", "runId", "bundleName", "bundleCompatTag"],
  "bundle.rollback.thresholdReached": [
    "actorId",
    "gameId",
    "runId",
    "bundleName",
    "failedBundleName",
  ],
  "connection.refused": ["reason"],
  "connection.replay": ["gameId", "playerId", "tokenShardId", "flyMachineId"],
  "game.deleted": ["gameId"],
  "game.released": ["gameId", "runnerId", "reason"],
  "game.woke": ["gameId", "runnerId", "bundleName", "bundleCompatTag"],
  "handler.complete": ["gameId", "handlerName"],
  "handler.error": ["gameId", "handlerName", "code"],
  "isolate.fatal": ["gameId", "message"],
  "isolate.ready": ["gameId", "runnerId", "bundleName", "bundleCompatTag"],
  "isolate.restart": ["gameId", "runnerId", "cause"],
  "isolate.restart.failed": ["gameId", "runnerId", "cause", "error"],
  "log.emit": ["gameId"],
  "lifecycle.sleepComplete": ["gameId", "reason"],
  "lifecycle.sleepGrace.cancelled": ["gameId", "cause"],
  "lifecycle.sleepGrace.expired": ["gameId"],
  "lifecycle.sleepGrace.started": ["gameId"],
  "metrics.emit": ["gameId"],
  "onSleep.deadline": ["gameId", "reason"],
  "onSleep.sent": ["gameId", "reason"],
  "onPlayerMessage": ["gameId", "sessionId", "playerId"],
  "onWake.failed": ["actorId", "gameId", "runId", "bundleName", "bundleCompatTag", "code"],
  "onWake.sent": ["actorId", "gameId", "runId", "bundleCompatTag"],
  "onWake.succeeded": ["actorId", "gameId", "runId", "bundleName", "bundleCompatTag"],
  "onHostEvent.delivered": ["gameId", "eventType"],
  "onHostEvent.received": ["gameId", "eventType"],
  "placement.accepted": ["gameId", "playerId", "shardId", "traceId", "bundleName"],
  "placement.refused": ["gameId", "playerId", "reason"],
  "placement.rejected": ["gameId", "error"],
  "player.deleted": ["playerId"],
  "players.allowed": ["gameId", "requestId"],
  "players.connected": ["gameId", "requestId"],
  "runner.assignmentRejected": ["runnerId", "gameId", "type"],
  "runner.crash": ["runnerId"],
  "runner.ready": ["runnerId", "kind"],
  "runner.unknownMessage": ["runnerId", "type"],
  "session.closed": ["gameId", "sessionId", "playerId"],
  "session.opened": ["gameId", "sessionId", "playerId"],
  "state.flush": ["gameId", "requestId"],
  "state.flush.plannedTransition": ["gameId"],
  "state.checkpoint": ["gameId"],
  "state.read": ["gameId", "requestId"],
  "state.write": ["gameId", "requestId"],
  "state.write.rejected": ["gameId", "error"],
  "storage.unavailable": ["gameId", "operation", "error"],
  "ws.recv.malformed": ["gameId", "sessionId", "playerId"],
  "ws.recv.oversized": ["gameId", "sessionId", "playerId"],
  "ws.send": ["gameId"],
  "ws.send.rejected": ["gameId", "error"],
};

export function historyCompleteness(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];
  const lastSeqByShard = new Map<string, number>();
  const isScenarioSlice = history.some((event) => event.shardId === "scenario-runner");

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
    } else if (
      !isScenarioSlice &&
      typeof event.shardId === "string" &&
      event.shardId.length > 0
    ) {
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
