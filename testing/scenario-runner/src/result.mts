import type { OracleResult } from "@pax-backend/oracles-lib";

import type {
  NemesisManifest,
  ScenarioManifest,
  ScenarioResult,
  ScenarioRunnerInput,
} from "./types.mjs";

export function buildScenarioResult(
  input: ScenarioRunnerInput,
  oracleResults: readonly OracleResult[],
  startedAtMs: number,
  finishedAtMs: number,
): ScenarioResult {
  const fallbackScenario: ScenarioManifest = {
    scenarioId: input.scenarioId,
    seed: "unloaded",
    determinism: "low",
    defaultMode: input.mode,
    defaultBackend: input.backend,
    defaultNemesis: input.nemesisManifest?.nemesisId ?? input.nemesisId ?? "no-faults",
    description: "Scenario manifest was not loaded for this replay.",
    oracleNames: oracleResults.map((oracle) => oracle.oracle),
  };
  const scenario = input.scenarioManifest ?? fallbackScenario;
  const fallbackNemesis: NemesisManifest = {
    nemesisId: input.nemesisId ?? scenario.defaultNemesis,
    description: "Nemesis manifest was not loaded for this replay.",
    actions: [{ type: "none" }],
  };
  const nemesis = input.nemesisManifest ?? fallbackNemesis;
  return {
    schema_version: 1,
    kind: input.mode,
    scenario_id: input.scenarioId,
    run_id: input.runId ?? `run_${startedAtMs}`,
    backend: input.backend,
    scenario: {
      seed: scenario.seed,
      determinism: scenario.determinism,
      default_mode: scenario.defaultMode,
      default_backend: scenario.defaultBackend,
      primary_oracle_names: scenario.oracleNames,
      description: scenario.description,
    },
    nemesis: {
      nemesis_id: nemesis.nemesisId,
      description: nemesis.description,
      actions: nemesis.actions,
    },
    workload: input.workloadPlan
      ? {
          bundle_name: input.workloadPlan.bundleName,
          game_id_prefix: input.workloadPlan.gameIdPrefix,
          duration_ms: input.workloadPlan.durationMs,
          max_games: input.workloadPlan.maxGames,
          fixtures: input.workloadPlan.fixtures,
          phases: input.workloadPlan.phases,
        }
      : undefined,
    oracle_scope: input.oracleScope ?? (input.oracleNames ? "explicit" : "all"),
    sampling_profile: input.samplingProfile ?? (input.mode === "replay" ? "replay" : "ramp"),
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: Math.max(0, finishedAtMs - startedAtMs),
    worker_count: input.workerCount ?? 1,
    worker_artifacts: [],
    metrics: { per_surface: {} },
    attribution: {
      sentence: "Attribution not computed by the source-only replay shell.",
      candidates: [],
      falsified: [],
    },
    oracles: Object.fromEntries(
      oracleResults.map((oracle) => [
        oracleResultKey(oracle),
        {
          ok: oracle.status === "pass",
          status: oracle.status,
          checkedEvents: oracle.checkedEvents,
          violations: oracle.findings,
        },
      ]),
    ),
    history_url: input.historyPath,
    trace_links: [],
  };
}

export function oracleResultKey(result: OracleResult): string {
  return `G${result.guarantee}_${result.oracle.replaceAll("-", "_")}`;
}
