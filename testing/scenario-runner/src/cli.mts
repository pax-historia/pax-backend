import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runReplayFromCatalog } from "./runner.mjs";
import type {
  NemesisKind,
  OracleScope,
  SamplingProfile,
  ScenarioBackend,
  ScenarioResult,
  ScenarioRunMode,
  ScenarioRunnerInput,
} from "./types.mjs";

interface CliOptions extends ScenarioRunnerInput {
  readonly outputPath?: string;
}

const MODES = new Set<ScenarioRunMode>(["load", "property", "fuzz", "replay"]);
const BACKENDS = new Set<ScenarioBackend>(["live", "mock-shard", "in-memory"]);
const NEMESES = new Set<NemesisKind>(["no-faults", "shard-death-every-5m"]);
const SAMPLING_PROFILES = new Set<SamplingProfile>(["ramp", "cliff_hold", "replay"]);

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${arg ?? ""}`);
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for --${key}`);
    }
    values.set(key, value);
    i += 1;
  }

  const scenarioId = required(values, "scenario");
  const historyPath = required(values, "history");
  const mode = parseMode(values.get("mode") ?? "replay");
  const backend = parseBackend(values.get("backend") ?? "live");
  const workerCount = parseOptionalPositiveInt(values.get("workers"));
  const oracles = parseOracles(values.get("oracles"));

  return {
    scenarioId,
    historyPath,
    mode,
    backend,
    runId: values.get("run-id"),
    workerCount,
    nemesisId: parseOptionalNemesis(values.get("nemesis")),
    scenarioCatalogDir: values.get("scenarios-dir"),
    nemesisCatalogDir: values.get("nemeses-dir"),
    scenarioManifestPath: values.get("scenario-manifest"),
    nemesisProfilePath: values.get("nemesis-profile"),
    workloadPath: values.get("workload"),
    workloadGameIdPrefix: values.get("game-id-prefix"),
    fixtureBaseDir: values.get("fixture-base-dir"),
    controlPlaneUrl: values.get("control-url"),
    apiGatewayUrl: values.get("api-gateway-url"),
    routerUrl: values.get("router-url"),
    phaseTimeoutMs: parseOptionalPositiveInt(values.get("phase-timeout-ms")),
    oracleScope: oracles.scope,
    oracleNames: oracles.names,
    samplingProfile: parseOptionalSamplingProfile(values.get("sampling-profile")),
    outputPath: values.get("output"),
  };
}

export async function runCli(argv: readonly string[]): Promise<number> {
  try {
    const options = parseCliArgs(argv);
    const result = await runReplayFromCatalog(options);
    const raw = `${JSON.stringify(result, null, 2)}\n`;
    if (options.outputPath) {
      writeFileSync(options.outputPath, raw);
    } else {
      process.stdout.write(raw);
    }
    return hasBlockingOracle(result) ? 2 : 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`missing --${key}`);
  return value;
}

function parseMode(value: string): ScenarioRunMode {
  if (!MODES.has(value as ScenarioRunMode)) {
    throw new Error(`invalid --mode ${value}`);
  }
  return value as ScenarioRunMode;
}

function parseBackend(value: string): ScenarioBackend {
  if (!BACKENDS.has(value as ScenarioBackend)) {
    throw new Error(`invalid --backend ${value}`);
  }
  return value as ScenarioBackend;
}

function parseOptionalNemesis(value: string | undefined): NemesisKind | undefined {
  if (value === undefined) return undefined;
  if (!NEMESES.has(value as NemesisKind)) {
    throw new Error(`invalid --nemesis ${value}`);
  }
  return value as NemesisKind;
}

function parseOptionalSamplingProfile(value: string | undefined): SamplingProfile | undefined {
  if (value === undefined) return undefined;
  if (!SAMPLING_PROFILES.has(value as SamplingProfile)) {
    throw new Error(`invalid --sampling-profile ${value}`);
  }
  return value as SamplingProfile;
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`expected positive integer, got ${value}`);
  }
  return parsed;
}

function parseOracles(
  value: string | undefined,
): { readonly scope: OracleScope; readonly names?: readonly string[] } {
  if (value === undefined || value === "all") return { scope: "all" };
  if (value === "scenario") return { scope: "scenario" };
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    throw new Error("--oracles must be all, scenario, or a comma-separated oracle list");
  }
  return { scope: "explicit", names };
}

function hasBlockingOracle(result: ScenarioResult): boolean {
  return Object.values(result.oracles).some((oracle) => oracle.status !== "pass");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
