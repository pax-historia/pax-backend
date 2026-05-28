import type { OracleResult } from "@pax-backend/oracles-lib";

import type { ScenarioResult, ScenarioRunnerInput } from "./types.mjs";

export function buildScenarioResult(
  input: ScenarioRunnerInput,
  oracleResults: readonly OracleResult[],
  startedAtMs: number,
  finishedAtMs: number,
): ScenarioResult {
  return {
    schema_version: 1,
    kind: input.mode,
    scenario_id: input.scenarioId,
    run_id: input.runId ?? `run_${startedAtMs}`,
    backend: input.backend,
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
