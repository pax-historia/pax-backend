import { allowedOnlyConnection } from "./allowed-only-connection.mjs";
import { blobDurability } from "./blob-durability.mjs";
import { bundleCompatibilitySafety } from "./bundle-compatibility-safety.mjs";
import { computePlaneQuotas } from "./compute-plane-quotas.mjs";
import { crashBlastRadius } from "./crash-blast-radius.mjs";
import { evictionMinimumBudget } from "./eviction-minimum-budget.mjs";
import { faithfulApiDispatch } from "./faithful-api-dispatch.mjs";
import { historyCompleteness } from "./history-completeness.mjs";
import { idempotentPlayerInput } from "./idempotent-player-input.mjs";
import { migrationRollbackSafety } from "./migration-rollback-safety.mjs";
import { noRandomParentCrashes } from "./no-random-parent-crashes.mjs";
import { placementContractSafety } from "./placement-contract-safety.mjs";
import { sessionObservabilityAccuracy } from "./session-observability-accuracy.mjs";
import { singletonGame } from "./singleton-game.mjs";
import { stateDurability } from "./state-durability.mjs";
import { uniqueStableSessionId } from "./unique-stable-sessionid.mjs";
import type { HistoryEvent, Oracle, OracleResult } from "../types.mjs";

export interface GuaranteeOracleEntry {
  readonly guarantee: number;
  readonly name: string;
  readonly oracle: Oracle;
}

export const guaranteeIndex = [
  { guarantee: 1, name: "singleton-game", oracle: singletonGame },
  { guarantee: 2, name: "allowed-only-connection", oracle: allowedOnlyConnection },
  { guarantee: 3, name: "unique-stable-sessionid", oracle: uniqueStableSessionId },
  { guarantee: 4, name: "session-observability-accuracy", oracle: sessionObservabilityAccuracy },
  { guarantee: 5, name: "faithful-api-dispatch", oracle: faithfulApiDispatch },
  { guarantee: 6, name: "idempotent-player-input", oracle: idempotentPlayerInput },
  { guarantee: 7, name: "compute-plane-quotas", oracle: computePlaneQuotas },
  { guarantee: 8, name: "crash-blast-radius", oracle: crashBlastRadius },
  { guarantee: 9, name: "no-random-parent-crashes", oracle: noRandomParentCrashes },
  { guarantee: 10, name: "eviction-minimum-budget", oracle: evictionMinimumBudget },
  { guarantee: 11, name: "state-durability", oracle: stateDurability },
  { guarantee: 12, name: "blob-durability", oracle: blobDurability },
  { guarantee: 13, name: "migration-rollback-safety", oracle: migrationRollbackSafety },
  { guarantee: 14, name: "history-completeness", oracle: historyCompleteness },
  { guarantee: 15, name: "bundle-compatibility-safety", oracle: bundleCompatibilitySafety },
  { guarantee: 16, name: "placement-contract-safety", oracle: placementContractSafety },
] satisfies readonly GuaranteeOracleEntry[];

export const guaranteeOracles = guaranteeIndex.map((entry) => entry.oracle);

export function runAllGuaranteeOracles(
  history: readonly HistoryEvent[],
): readonly OracleResult[] {
  return guaranteeIndex.map((entry) => entry.oracle(history));
}

export {
  allowedOnlyConnection,
  blobDurability,
  bundleCompatibilitySafety,
  computePlaneQuotas,
  crashBlastRadius,
  evictionMinimumBudget,
  faithfulApiDispatch,
  historyCompleteness,
  idempotentPlayerInput,
  migrationRollbackSafety,
  noRandomParentCrashes,
  placementContractSafety,
  sessionObservabilityAccuracy,
  singletonGame,
  stateDurability,
  uniqueStableSessionId,
};
