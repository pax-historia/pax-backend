import { readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadScenarioManifest } from "./catalog.mjs";
import { runReplayFromCatalog } from "./runner.mjs";
import type {
  NemesisKind,
  ScenarioResult,
  ScenarioRunnerInput,
  ScenarioSuiteCaseSummary,
  ScenarioSuiteResult,
  ScenarioSuiteRunnerInput,
} from "./types.mjs";

export async function runScenarioSuite(
  input: ScenarioSuiteRunnerInput,
): Promise<ScenarioSuiteResult> {
  const startedAtMs = Date.now();
  const suiteRunNonce = safeCaseId(String(startedAtMs));
  const scenarioCatalogDir = resolve(input.scenarioCatalogDir ?? "testing/scenarios");
  const nemesisCatalogDir = resolve(input.nemesisCatalogDir ?? "testing/nemeses");
  const outputDir = resolve(input.outputDir);
  await mkdir(outputDir, { recursive: true });
  const scenarioIds = input.scenarioIds ?? (await discoverScenarioIds(scenarioCatalogDir));
  const nemesisIds = input.nemesisIds ?? (await discoverNemesisIds(nemesisCatalogDir));
  const cases: ScenarioSuiteCaseSummary[] = [];

  for (const scenarioId of scenarioIds) {
    const manifest = await loadScenarioManifest({
      scenarioId,
      scenarioCatalogDir,
      mode: input.mode ?? "load",
      backend: input.backend ?? "live",
      historyPath: "unused",
    });
    for (const nemesisId of nemesisIds) {
      const caseStartedAtMs = Date.now();
      const caseId = safeCaseId(`${input.runtimeKind}-${scenarioId}-${nemesisId}`);
      const historyPath = join(outputDir, `${caseId}.history.jsonl`);
      const resultPath = join(outputDir, `${caseId}.result.json`);
      await writeFile(historyPath, "", "utf8");
      try {
        const result = await runReplayFromCatalog({
          scenarioId,
          mode: input.mode ?? manifest.defaultMode,
          backend: input.backend ?? manifest.defaultBackend,
          historyPath,
          runId: `suite-${caseId}-${caseStartedAtMs}`,
          workerCount: input.workerCount,
          nemesisId,
          scenarioCatalogDir,
          nemesisCatalogDir,
          workloadGameIdPrefix: safeCaseId(
            `${scenarioId}-${nemesisId}-${input.runtimeKind}-${suiteRunNonce}`,
          ),
          controlPlaneUrl: input.controlPlaneUrl,
          apiGatewayUrl: input.apiGatewayUrl,
          routerUrl: input.routerUrl,
          phaseTimeoutMs: input.phaseTimeoutMs,
          metricsScrapeIntervalMs: input.metricsScrapeIntervalMs,
          oracleScope: input.oracleScope,
          oracleNames: input.oracleNames,
          samplingProfile: input.samplingProfile,
        } satisfies ScenarioRunnerInput);
        await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
        const failingOracles = failingOracleNames(result);
        cases.push({
          scenario_id: scenarioId,
          nemesis_id: nemesisId,
          runtime_kind: input.runtimeKind,
          mode: result.kind,
          backend: result.backend,
          status: failingOracles.length > 0 ? "fail" : "pass",
          history_path: historyPath,
          result_path: resultPath,
          duration_ms: Date.now() - caseStartedAtMs,
          failing_oracles: failingOracles,
        });
      } catch (err) {
        cases.push({
          scenario_id: scenarioId,
          nemesis_id: nemesisId,
          runtime_kind: input.runtimeKind,
          mode: input.mode ?? manifest.defaultMode,
          backend: input.backend ?? manifest.defaultBackend,
          status: "error",
          history_path: historyPath,
          duration_ms: Date.now() - caseStartedAtMs,
          failing_oracles: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const finishedAtMs = Date.now();
  const result: ScenarioSuiteResult = {
    schema_version: 1,
    kind: "scenario-suite",
    runtime_kind: input.runtimeKind,
    scenario_catalog_dir: scenarioCatalogDir,
    nemesis_catalog_dir: nemesisCatalogDir,
    output_dir: outputDir,
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: finishedAtMs - startedAtMs,
    summary: {
      total: cases.length,
      passed: cases.filter((entry) => entry.status === "pass").length,
      failed: cases.filter((entry) => entry.status === "fail").length,
      errored: cases.filter((entry) => entry.status === "error").length,
    },
    cases,
  };
  await writeFile(join(outputDir, "suite.result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

export async function discoverScenarioIds(catalogDir: string): Promise<readonly string[]> {
  const entries = await readdir(catalogDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .filter((entry) => existsSync(join(catalogDir, entry, "manifest.mts")))
    .sort();
}

export async function discoverNemesisIds(catalogDir: string): Promise<readonly NemesisKind[]> {
  const entries = await readdir(catalogDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .filter((entry) => existsSync(join(catalogDir, entry, "fault-profile.mts")))
    .sort() as readonly NemesisKind[];
}

function failingOracleNames(result: ScenarioResult): readonly string[] {
  return Object.entries(result.oracles)
    .filter(([_name, oracle]) => oracle.status !== "pass" || oracle.ok !== true)
    .map(([name]) => name);
}

function safeCaseId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}
