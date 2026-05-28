import { finding, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "migration-rollback-safety";
const GUARANTEE = 13;

export function migrationRollbackSafety(history: readonly HistoryEvent[]): OracleResult {
  const findings: OracleFinding[] = [];
  const pendingThresholds: Array<{
    readonly gameId: string;
    readonly failedBundleName: string;
    readonly event: HistoryEvent;
  }> = [];
  let observed = 0;

  for (const event of history) {
    if (event.event === "bundle.flip.succeeded") {
      observed += 1;
      if (
        !stringField(event, "gameId") ||
        !stringField(event, "oldBundleName") ||
        !stringField(event, "newBundleName")
      ) {
        findings.push(
          finding(
            "missing-flip-scope",
            "bundle.flip.succeeded must include gameId, oldBundleName, and newBundleName",
            event,
          ),
        );
      }
      continue;
    }

    if (event.event === "bundle.rollback.thresholdReached") {
      observed += 1;
      const gameId = stringField(event, "gameId");
      const failedBundleName = stringField(event, "failedBundleName");
      if (!gameId || !failedBundleName || !stringField(event, "bundleName")) {
        findings.push(
          finding(
            "missing-threshold-scope",
            "bundle.rollback.thresholdReached must include gameId, bundleName, and failedBundleName",
            event,
          ),
        );
      } else {
        pendingThresholds.push({ gameId, failedBundleName, event });
      }
    }

    if (event.event === "bundle.rollback") {
      observed += 1;
      const gameId = stringField(event, "gameId");
      const failedBundleName = stringField(event, "failedBundleName");
      if (!gameId || !stringField(event, "bundleName") || !failedBundleName) {
        findings.push(
          finding(
            "missing-rollback-scope",
            "bundle.rollback must include gameId, bundleName, and failedBundleName",
            event,
          ),
        );
      } else {
        const pendingIndex = pendingThresholds.findIndex(
          (pending) =>
            pending.gameId === gameId && pending.failedBundleName === failedBundleName,
        );
        if (pendingIndex >= 0) pendingThresholds.splice(pendingIndex, 1);
      }
    }
    if (event.event === "bundle.rollback.rejected" || event.event === "bundle.rollback.error") {
      observed += 1;
      findings.push(
        finding(
          "rollback-not-completed",
          "rollback threshold must complete with bundle.rollback, not a rejected/error event",
          event,
        ),
      );
    }
    if (event.event === "child.handlerError" && stringField(event, "handler") === "onWake") {
      observed += 1;
    }
  }

  for (const pending of pendingThresholds) {
    findings.push(
      finding(
        "rollback-missing-after-threshold",
        "N consecutive onWake failures must be followed by bundle.rollback",
        pending.event,
        {
          gameId: pending.gameId,
          failedBundleName: pending.failedBundleName,
        },
      ),
    );
  }

  return result(ORACLE, GUARANTEE, history, observed, findings);
}
