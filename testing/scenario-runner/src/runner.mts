import {
  readHistoryJsonl,
  runAllGuaranteeOracles,
} from "@pax-backend/oracles-lib";

import { buildScenarioResult } from "./result.mjs";
import type { ScenarioResult, ScenarioRunnerInput } from "./types.mjs";

export function runReplayFromHistory(input: ScenarioRunnerInput): ScenarioResult {
  const startedAtMs = Date.now();
  const history = readHistoryJsonl(input.historyPath);
  const oracleResults = runAllGuaranteeOracles(history);
  const finishedAtMs = Date.now();
  return buildScenarioResult(input, oracleResults, startedAtMs, finishedAtMs);
}
