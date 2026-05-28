import {
  readHistoryJsonl,
  runAllGuaranteeOracles,
  runNamedGuaranteeOracles,
} from "@pax-backend/oracles-lib";

import { summarizeHistoryAttribution } from "./attribution.mjs";
import {
  loadNemesisManifest,
  loadScenarioLocalOracles,
  loadScenarioManifest,
  loadScenarioWorkloadPlan,
} from "./catalog.mjs";
import { appendArchivedHistory, appendControlPlaneHistory } from "./history-archive.mjs";
import { executeLiveWorkload } from "./live-executor.mjs";
import { ScenarioMetricsCollector } from "./metrics-collector.mjs";
import { buildScenarioResult } from "./result.mjs";
import { buildScenarioRuntimeEnvironment } from "./runtime-env.mjs";
import type {
  ScenarioAttribution,
  ScenarioMetrics,
  ScenarioResult,
  ScenarioRunnerInput,
} from "./types.mjs";

export function runReplayFromHistory(input: ScenarioRunnerInput): ScenarioResult {
  const startedAtMs = Date.now();
  const history = readHistoryJsonl(input.historyPath);
  const analysis = summarizeHistoryAttribution(history);
  const oracleResults = input.oracleNames
    ? runNamedGuaranteeOracles(history, input.oracleNames)
    : runAllGuaranteeOracles(history);
  const scenarioOracleResults = input.scenarioLocalOracles?.map((oracle) => oracle(history)) ?? [];
  const finishedAtMs = Date.now();
  return buildScenarioResult(
    {
      ...input,
      metrics: input.metrics ?? analysis.metrics,
      attribution: input.attribution ?? analysis.attribution,
    },
    [...oracleResults, ...scenarioOracleResults],
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
  const scenarioLocalOracles = await loadScenarioLocalOracles(input, scenarioManifest);
  const runtimeEnvironment =
    input.runtimeEnvironment ??
    (workloadPlan
      ? buildScenarioRuntimeEnvironment(input, scenarioManifest, workloadPlan)
      : undefined);
  const oracleNames =
    input.oracleScope === "scenario" ? scenarioManifest.oracleNames : input.oracleNames;
  const hydratedInput: ScenarioRunnerInput = {
    ...input,
    scenarioManifest,
    nemesisManifest,
    workloadPlan,
    runtimeEnvironment,
    scenarioLocalOracles,
    oracleNames,
    oracleScope: input.oracleScope ?? (input.oracleNames ? "explicit" : "all"),
    samplingProfile: input.samplingProfile ?? (input.mode === "replay" ? "replay" : "ramp"),
  };
  let liveMetrics: ScenarioMetrics | undefined;
  let liveAttribution: ScenarioAttribution | undefined;
  if (input.mode !== "replay") {
    if (!workloadPlan || !runtimeEnvironment) {
      throw new Error(`${scenarioManifest.scenarioId} has no workload plan to execute`);
    }
    const gameIds = scenarioGameIds(workloadPlan);
    const liveStartedAtMs = Date.now();
    const metricsCollector = new ScenarioMetricsCollector(
      hydratedInput,
      hydratedInput.samplingProfile ?? "ramp",
    );
    await metricsCollector.start();
    try {
      await executeLiveWorkload(
        hydratedInput,
        scenarioManifest,
        workloadPlan,
        runtimeEnvironment,
      );
      const liveFinishedAtMs = Date.now();
      await appendArchivedHistory({
        historyPath: hydratedInput.historyPath,
        startedAtMs: liveStartedAtMs,
        finishedAtMs: liveFinishedAtMs,
        gameIds,
      });
      await appendControlPlaneHistory({
        historyPath: hydratedInput.historyPath,
        controlPlaneUrl: hydratedInput.controlPlaneUrl ?? process.env["PAX_CONTROL_URL"],
        gameIds,
        startedAtMs: liveStartedAtMs,
        finishedAtMs: liveFinishedAtMs,
      });
    } finally {
      const collection = await metricsCollector.stop();
      liveMetrics = collection.metrics;
      liveAttribution = collection.attribution;
    }
  }
  return runReplayFromHistory({
    ...hydratedInput,
    metrics: hydratedInput.metrics ?? liveMetrics,
    attribution: hydratedInput.attribution ?? liveAttribution,
  });
}

function scenarioGameIds(workload: NonNullable<ScenarioRunnerInput["workloadPlan"]>): readonly string[] {
  return Array.from(
    { length: workload.maxGames },
    (_unused, index) => `${workload.gameIdPrefix}-${index + 1}`,
  );
}
