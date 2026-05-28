import {
  readHistoryJsonl,
  runAllGuaranteeOracles,
  runNamedGuaranteeOracles,
} from "@pax-backend/oracles-lib";

import {
  loadNemesisManifest,
  loadScenarioManifest,
  loadScenarioWorkloadPlan,
} from "./catalog.mjs";
import { buildScenarioResult } from "./result.mjs";
import type { ScenarioResult, ScenarioRunnerInput } from "./types.mjs";

export function runReplayFromHistory(input: ScenarioRunnerInput): ScenarioResult {
  const startedAtMs = Date.now();
  const history = readHistoryJsonl(input.historyPath);
  const oracleResults = input.oracleNames
    ? runNamedGuaranteeOracles(history, input.oracleNames)
    : runAllGuaranteeOracles(history);
  const finishedAtMs = Date.now();
  return buildScenarioResult(input, oracleResults, startedAtMs, finishedAtMs);
}

export async function runReplayFromCatalog(
  input: ScenarioRunnerInput,
): Promise<ScenarioResult> {
  const scenarioManifest = await loadScenarioManifest(input);
  const nemesisManifest = await loadNemesisManifest(input, scenarioManifest);
  const workloadPlan = await loadScenarioWorkloadPlan(input, scenarioManifest);
  const oracleNames =
    input.oracleScope === "scenario" ? scenarioManifest.oracleNames : input.oracleNames;
  return runReplayFromHistory({
    ...input,
    scenarioManifest,
    nemesisManifest,
    workloadPlan,
    oracleNames,
    oracleScope: input.oracleScope ?? (input.oracleNames ? "explicit" : "all"),
    samplingProfile: input.samplingProfile ?? (input.mode === "replay" ? "replay" : "ramp"),
  });
}
