import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runReplayFromHistory } from "./runner.mjs";
import type { ScenarioBackend, ScenarioRunMode, ScenarioRunnerInput } from "./types.mjs";

interface CliOptions extends ScenarioRunnerInput {
  readonly outputPath?: string;
}

const MODES = new Set<ScenarioRunMode>(["load", "property", "fuzz", "replay"]);
const BACKENDS = new Set<ScenarioBackend>(["live", "mock-shard", "in-memory"]);

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

  return {
    scenarioId,
    historyPath,
    mode,
    backend,
    runId: values.get("run-id"),
    workerCount,
    outputPath: values.get("output"),
  };
}

export function runCli(argv: readonly string[]): number {
  try {
    const options = parseCliArgs(argv);
    const result = runReplayFromHistory(options);
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

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`expected positive integer, got ${value}`);
  }
  return parsed;
}

function hasBlockingOracle(result: ReturnType<typeof runReplayFromHistory>): boolean {
  return Object.values(result.oracles).some((oracle) => oracle.status !== "pass");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2));
}
