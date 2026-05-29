import { writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runReplayFromCatalog } from "./runner.mjs";
import type {
  ScaleLadderPlan,
  ScaleLadderResult,
  ScaleRungCaseSummary,
  ScaleRungResult,
  ScaleRungSpec,
  ScenarioResult,
  ScenarioScaleRunnerInput,
} from "./types.mjs";

const MODES = ["load", "property", "fuzz", "replay"] as const;
const BACKENDS = ["live", "mock-shard", "in-memory"] as const;
const ORACLE_SCOPES = ["all", "scenario", "explicit"] as const;
const NEMESES = [
  "no-faults",
  "shard-death-every-5m",
  "api-kind-partition-burst",
  "runner-crash-on-await",
] as const;
const SAMPLING_PROFILES = ["ramp", "cliff_hold", "replay"] as const;

export async function runScaleLadder(
  input: ScenarioScaleRunnerInput,
): Promise<ScaleLadderResult> {
  const startedAtMs = Date.now();
  const planPath = resolvePath(input.scalePlanPath);
  const outputDir = resolve(input.outputDir);
  await mkdir(outputDir, { recursive: true });
  const plan = await loadScaleLadderPlan(planPath);
  const rungs = selectedRungs(plan, input.rungIds);
  const rungResults: ScaleRungResult[] = [];

  for (const rung of rungs) {
    rungResults.push(await runScaleRung(plan, rung, input, outputDir));
  }

  const finishedAtMs = Date.now();
  const result: ScaleLadderResult = {
    schema_version: 1,
    kind: "scale-ladder",
    ladder_id: plan.ladderId,
    description: plan.description,
    plan_path: planPath,
    output_dir: outputDir,
    runtime_kind: input.runtimeKind,
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: finishedAtMs - startedAtMs,
    summary: summarizeLadder(rungResults),
    rungs: rungResults,
  };
  await writeFile(join(outputDir, "scale-ladder.result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export async function loadScaleLadderPlan(path: string): Promise<ScaleLadderPlan> {
  const mod = (await import(pathToFileURL(resolvePath(path)).href)) as { default?: unknown };
  return validateScaleLadderPlan(mod.default, path);
}

async function runScaleRung(
  plan: ScaleLadderPlan,
  rung: ScaleRungSpec,
  input: ScenarioScaleRunnerInput,
  outputDir: string,
): Promise<ScaleRungResult> {
  const startedAtMs = Date.now();
  const scenarioId = rung.scenarioId ?? plan.defaultScenarioId;
  const samplingProfile = input.samplingProfile ?? rung.samplingProfile ?? "ramp";
  const mode = input.mode ?? plan.defaultMode ?? "load";
  const backend = input.backend ?? plan.defaultBackend ?? "live";
  const oracleScope = input.oracleScope ?? plan.defaultOracleScope;
  const rungOutputDir = join(outputDir, safeCaseId(rung.rungId));
  await mkdir(rungOutputDir, { recursive: true });
  const cases: ScaleRungCaseSummary[] = [];
  const nemesisIds = input.nemesisIds ?? rung.nemesisIds;

  for (const nemesisId of nemesisIds) {
    const caseStartedAtMs = Date.now();
    const caseId = safeCaseId(`${input.runtimeKind}-${scenarioId}-${rung.rungId}-${nemesisId}`);
    const caseRunId = `scale-${caseId}-${caseStartedAtMs}`;
    const workloadGameIdPrefix = safeCaseId(
      `${scenarioId}-${rung.rungId}-${input.runtimeKind}-${nemesisId}-${caseStartedAtMs}`,
    );
    const historyPath = join(rungOutputDir, `${caseId}.history.jsonl`);
    const resultPath = join(rungOutputDir, `${caseId}.result.json`);
    await writeFile(historyPath, "", "utf8");
    try {
      const result = await runReplayFromCatalog({
        scenarioId,
        mode,
        backend,
        historyPath,
        runId: caseRunId,
        workerCount: rung.workerCount ?? input.workerCount,
        nemesisId,
        scenarioCatalogDir: input.scenarioCatalogDir ?? plan.scenarioCatalogDir,
        nemesisCatalogDir: input.nemesisCatalogDir ?? plan.nemesisCatalogDir,
        workloadGameIdPrefix,
        workloadMaxGames: rung.concurrentGames,
        workloadDurationMs: rung.targetDurationMs,
        workloadSessionsPerGame: rung.sessionsPerGame,
        workloadOpenSessionsRampMs: rung.rampMs,
        workloadSendJsonIntervalMs: rung.sendJsonIntervalMs,
        workloadSendJsonFanoutMs: rung.sendJsonFanoutMs,
        controlPlaneUrl: input.controlPlaneUrl,
        apiGatewayUrl: input.apiGatewayUrl,
        routerUrl: input.routerUrl,
        phaseTimeoutMs: input.phaseTimeoutMs,
        metricsScrapeIntervalMs: input.metricsScrapeIntervalMs,
        oracleScope,
        oracleNames: input.oracleNames,
        samplingProfile,
      });
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
        attribution_sentence: result.attribution.sentence,
      });
    } catch (err) {
      cases.push({
        scenario_id: scenarioId,
        nemesis_id: nemesisId,
        runtime_kind: input.runtimeKind,
        mode,
        backend,
        status: "error",
        history_path: historyPath,
        duration_ms: Date.now() - caseStartedAtMs,
        failing_oracles: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const finishedAtMs = Date.now();
  const result: ScaleRungResult = {
    schema_version: 1,
    kind: "scale-rung",
    ladder_id: plan.ladderId,
    rung_id: rung.rungId,
    runtime_kind: input.runtimeKind,
    scenario_id: scenarioId,
    concurrent_games: rung.concurrentGames,
    shard_machines: rung.shardMachines,
    sessions_per_game: rung.sessionsPerGame,
    target_duration_ms: rung.targetDurationMs,
    ramp_ms: rung.rampMs,
    send_json_interval_ms: rung.sendJsonIntervalMs,
    send_json_fanout_ms: rung.sendJsonFanoutMs,
    sampling_profile: samplingProfile,
    nemesis_ids: nemesisIds,
    output_dir: rungOutputDir,
    started_at: new Date(startedAtMs).toISOString(),
    finished_at: new Date(finishedAtMs).toISOString(),
    duration_ms: finishedAtMs - startedAtMs,
    summary: summarizeCases(cases),
    cases,
    attribution_sentences: cases
      .map((entry) => entry.attribution_sentence)
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    notes: rung.notes,
  };
  await writeFile(join(rungOutputDir, "rung.result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function selectedRungs(
  plan: ScaleLadderPlan,
  rungIds: readonly string[] | undefined,
): readonly ScaleRungSpec[] {
  if (!rungIds || rungIds.length === 0) return plan.rungs;
  const byId = new Map(plan.rungs.map((rung) => [rung.rungId, rung]));
  return rungIds.map((rungId) => {
    const rung = byId.get(rungId);
    if (!rung) throw new Error(`scale rung ${rungId} is not defined in ${plan.ladderId}`);
    return rung;
  });
}

function summarizeCases(cases: readonly ScaleRungCaseSummary[]): ScaleRungResult["summary"] {
  return {
    total: cases.length,
    passed: cases.filter((entry) => entry.status === "pass").length,
    failed: cases.filter((entry) => entry.status === "fail").length,
    errored: cases.filter((entry) => entry.status === "error").length,
  };
}

function summarizeLadder(rungs: readonly ScaleRungResult[]): ScaleLadderResult["summary"] {
  const cases = rungs.flatMap((rung) => rung.cases);
  return {
    total_rungs: rungs.length,
    passed_rungs: rungs.filter((rung) => rung.summary.failed === 0 && rung.summary.errored === 0).length,
    failed_rungs: rungs.filter((rung) => rung.summary.failed > 0 && rung.summary.errored === 0).length,
    errored_rungs: rungs.filter((rung) => rung.summary.errored > 0).length,
    total_cases: cases.length,
    passed_cases: cases.filter((entry) => entry.status === "pass").length,
    failed_cases: cases.filter((entry) => entry.status === "fail").length,
    errored_cases: cases.filter((entry) => entry.status === "error").length,
  };
}

function failingOracleNames(result: ScenarioResult): readonly string[] {
  return Object.entries(result.oracles)
    .filter(([_name, oracle]) => oracle.status !== "pass" || oracle.ok !== true)
    .map(([name]) => name);
}

function validateScaleLadderPlan(value: unknown, path: string): ScaleLadderPlan {
  if (!isRecord(value)) throw new Error(`${path} must default-export a scale ladder plan`);
  const plan = value as Partial<ScaleLadderPlan>;
  requireExactNumber(plan.schemaVersion, 1, path, "schemaVersion");
  requireString(plan.ladderId, path, "ladderId");
  requireString(plan.description, path, "description");
  requireString(plan.defaultScenarioId, path, "defaultScenarioId");
  if (plan.scenarioCatalogDir !== undefined) {
    requireString(plan.scenarioCatalogDir, path, "scenarioCatalogDir");
  }
  if (plan.nemesisCatalogDir !== undefined) {
    requireString(plan.nemesisCatalogDir, path, "nemesisCatalogDir");
  }
  if (plan.defaultMode !== undefined) {
    requireOneOf(plan.defaultMode, path, "defaultMode", MODES);
  }
  if (plan.defaultBackend !== undefined) {
    requireOneOf(plan.defaultBackend, path, "defaultBackend", BACKENDS);
  }
  if (plan.defaultOracleScope !== undefined) {
    requireOneOf(plan.defaultOracleScope, path, "defaultOracleScope", ORACLE_SCOPES);
  }
  if (!Array.isArray(plan.rungs) || plan.rungs.length === 0) {
    throw new Error(`${path} field rungs must be a non-empty array`);
  }
  for (const [index, rung] of plan.rungs.entries()) {
    validateScaleRung(rung, path, index);
  }
  return plan as ScaleLadderPlan;
}

function validateScaleRung(value: unknown, path: string, index: number): void {
  const prefix = `rungs[${index}]`;
  if (!isRecord(value)) throw new Error(`${path} field ${prefix} must be an object`);
  requireString(value["rungId"], path, `${prefix}.rungId`);
  requirePositiveInteger(value["concurrentGames"], path, `${prefix}.concurrentGames`);
  requirePositiveInteger(value["shardMachines"], path, `${prefix}.shardMachines`);
  requirePositiveInteger(value["targetDurationMs"], path, `${prefix}.targetDurationMs`);
  requireNonNegativeNumber(value["rampMs"], path, `${prefix}.rampMs`);
  requirePositiveInteger(value["sessionsPerGame"], path, `${prefix}.sessionsPerGame`);
  if (value["sendJsonIntervalMs"] !== undefined) {
    requireNonNegativeNumber(value["sendJsonIntervalMs"], path, `${prefix}.sendJsonIntervalMs`);
  }
  if (value["sendJsonFanoutMs"] !== undefined) {
    requireNonNegativeNumber(value["sendJsonFanoutMs"], path, `${prefix}.sendJsonFanoutMs`);
  }
  if (value["scenarioId"] !== undefined) {
    requireString(value["scenarioId"], path, `${prefix}.scenarioId`);
  }
  if (!Array.isArray(value["nemesisIds"]) || value["nemesisIds"].length === 0) {
    throw new Error(`${path} field ${prefix}.nemesisIds must be a non-empty array`);
  }
  for (const [nemesisIndex, nemesisId] of value["nemesisIds"].entries()) {
    requireOneOf(nemesisId, path, `${prefix}.nemesisIds[${nemesisIndex}]`, NEMESES);
  }
  if (value["samplingProfile"] !== undefined) {
    requireOneOf(value["samplingProfile"], path, `${prefix}.samplingProfile`, SAMPLING_PROFILES);
  }
  if (value["workerCount"] !== undefined) {
    requirePositiveInteger(value["workerCount"], path, `${prefix}.workerCount`);
  }
  if (value["notes"] !== undefined) {
    requireString(value["notes"], path, `${prefix}.notes`);
  }
}

function requireString(value: unknown, path: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} field ${field} must be a non-empty string`);
  }
}

function requirePositiveInteger(value: unknown, path: string, field: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${path} field ${field} must be a positive integer`);
  }
}

function requireNonNegativeNumber(value: unknown, path: string, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} field ${field} must be a non-negative number`);
  }
}

function requireExactNumber(value: unknown, expected: number, path: string, field: string): void {
  if (value !== expected) {
    throw new Error(`${path} field ${field} must be ${expected}`);
  }
}

function requireOneOf<T extends string>(
  value: unknown,
  path: string,
  field: string,
  allowed: readonly T[],
): void {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${path} field ${field} must be one of ${allowed.join(", ")}`);
  }
}

function safeCaseId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function resolvePath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
