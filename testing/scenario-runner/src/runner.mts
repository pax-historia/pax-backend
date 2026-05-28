import {
  readHistoryJsonl,
  runAllGuaranteeOracles,
  runNamedGuaranteeOracles,
} from "@pax-backend/oracles-lib";

import { summarizeHistoryAttribution } from "./attribution.mjs";
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
  const analysis = summarizeHistoryAttribution(history);
  const oracleResults = input.oracleNames
    ? runNamedGuaranteeOracles(history, input.oracleNames)
    : runAllGuaranteeOracles(history);
  const finishedAtMs = Date.now();
  return buildScenarioResult(
    {
      ...input,
      metrics: input.metrics ?? analysis.metrics,
      attribution: input.attribution ?? analysis.attribution,
    },
    oracleResults,
    startedAtMs,
    finishedAtMs,
  );
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
