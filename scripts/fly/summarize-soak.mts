import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";

interface CliOptions {
  readonly soakDir: string;
  readonly outputPath: string;
  readonly expectCaseIds: readonly string[];
  readonly expectCases?: number;
  readonly expectTargetGames?: number;
  readonly expectPlacementShards?: number;
  readonly expectMinCaseDurationMs?: number;
  readonly expectMinPhaseDurationMs: Readonly<Record<string, number>>;
  readonly expectCompletedPhases: readonly string[];
  readonly expectExitCode?: string;
  readonly requireResults: boolean;
}

interface HistoryEvent {
  readonly event?: unknown;
  readonly ts?: unknown;
  readonly phaseType?: unknown;
  readonly phaseIndex?: unknown;
  readonly durationMs?: unknown;
  readonly code?: unknown;
  readonly reason?: unknown;
  readonly placedShardId?: unknown;
  readonly shardId?: unknown;
  readonly error?: unknown;
}

interface CaseSummary {
  readonly case_id: string;
  readonly history_path: string;
  readonly result_path?: string;
  readonly history_events: number;
  readonly parse_errors: readonly string[];
  readonly placement_count: number;
  readonly placement_distribution: Readonly<Record<string, number>>;
  readonly observed_placement_shards: number;
  readonly phases_started: readonly string[];
  readonly phases_completed: readonly string[];
  readonly completed_phase_durations_ms: Readonly<Record<string, readonly number[]>>;
  readonly session_closed_count: number;
  readonly session_close_code_distribution: Readonly<Record<string, number>>;
  readonly session_close_reason_distribution: Readonly<Record<string, number>>;
  readonly error_events: readonly string[];
  readonly first_event_at?: string;
  readonly last_event_at?: string;
  readonly duration_ms?: number;
  readonly result_status?: "pass" | "fail" | "error";
  readonly failing_oracles: readonly string[];
  readonly attribution_sentence?: string;
}

interface MonitorSummary {
  readonly path: string;
  readonly snapshots: number;
  readonly parse_errors: readonly string[];
  readonly first_snapshot_at?: string;
  readonly last_snapshot_at?: string;
  readonly last_process_alive?: boolean;
  readonly last_exit_code?: string | number | null;
  readonly last_shard_count?: number;
  readonly last_active_games?: number;
  readonly last_failures?: number;
  readonly last_session_closed?: number;
  readonly last_session_errors?: number;
  readonly last_capacity_warnings?: number;
  readonly last_budget_rejects?: number;
}

interface SoakSummary {
  readonly schema_version: 1;
  readonly kind: "phase-5-soak-summary";
  readonly generated_at: string;
  readonly soak_dir: string;
  readonly run_exit_code?: string;
  readonly cases: readonly CaseSummary[];
  readonly monitor?: MonitorSummary;
  readonly summary: {
    readonly total_cases: number;
    readonly result_files: number;
    readonly total_history_events: number;
    readonly total_placements: number;
    readonly observed_placement_shards: number;
    readonly parse_error_count: number;
    readonly monitor_parse_error_count: number;
    readonly failing_cases: number;
    readonly errored_cases: number;
    readonly gates_ok: boolean;
    readonly gate_failures: readonly string[];
  };
}

const SCENARIO_RESULT_KINDS = new Set(["load", "property", "fuzz", "replay"]);

const options = parseArgs(process.argv.slice(2));
const soakDir = resolve(options.soakDir);
const files = await listFiles(soakDir);
const historyPaths = files.filter((path) => path.endsWith(".history.jsonl")).sort();
const runExitCode = await readOptionalText(join(soakDir, "exit.code"));
const monitor = await summarizeMonitor(
  soakDir,
  files.find((path) => path === join(soakDir, "monitor", "status.jsonl")) ??
    files.find((path) => path === join(soakDir, "monitor", "status.tsv")),
);
const resultByCase = new Map(
  files
    .filter((path) => path.endsWith(".result.json"))
    .map((path) => [caseIdFromPath(path, ".result.json"), path] as const),
);
const cases = await Promise.all(
  historyPaths.map((historyPath) =>
    summarizeCase(soakDir, historyPath, resultByCase.get(caseIdFromPath(historyPath, ".history.jsonl"))),
  ),
);
const allShardIds = new Set<string>();
for (const entry of cases) {
  for (const shardId of Object.keys(entry.placement_distribution)) allShardIds.add(shardId);
}
const gateFailures = gateFailuresFor(options, cases, monitor, runExitCode);
const summary: SoakSummary = {
  schema_version: 1,
  kind: "phase-5-soak-summary",
  generated_at: new Date().toISOString(),
  soak_dir: soakDir,
  run_exit_code: runExitCode,
  cases,
  monitor,
  summary: {
    total_cases: cases.length,
    result_files: cases.filter((entry) => entry.result_path).length,
    total_history_events: cases.reduce((sum, entry) => sum + entry.history_events, 0),
    total_placements: cases.reduce((sum, entry) => sum + entry.placement_count, 0),
    observed_placement_shards: allShardIds.size,
    parse_error_count: cases.reduce((sum, entry) => sum + entry.parse_errors.length, 0),
    monitor_parse_error_count: monitor?.parse_errors.length ?? 0,
    failing_cases: cases.filter((entry) => entry.result_status === "fail").length,
    errored_cases: cases.filter((entry) => entry.result_status === "error").length,
    gates_ok: gateFailures.length === 0,
    gate_failures: gateFailures,
  },
};

await mkdir(dirname(resolve(options.outputPath)), { recursive: true });
await writeFile(options.outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (!summary.summary.gates_ok) process.exitCode = 2;

async function summarizeCase(
  root: string,
  historyPath: string,
  resultPath: string | undefined,
): Promise<CaseSummary> {
  const placementCounts = new Map<string, number>();
  const phasesStarted: string[] = [];
  const phasesCompleted: string[] = [];
  const completedPhaseDurations = new Map<string, number[]>();
  const closeCodeCounts = new Map<string, number>();
  const closeReasonCounts = new Map<string, number>();
  const parseErrors: string[] = [];
  const errorEvents: string[] = [];
  let historyEvents = 0;
  let firstEventAt: string | undefined;
  let lastEventAt: string | undefined;

  for await (const { line, lineNumber } of readNonEmptyLines(historyPath)) {
    let event: HistoryEvent;
    try {
      event = JSON.parse(line) as HistoryEvent;
    } catch (err) {
      parseErrors.push(
        `${relative(root, historyPath)}:${lineNumber}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }
    historyEvents += 1;
    const timestamp = stringValue(event.ts);
    if (timestamp && !firstEventAt) firstEventAt = timestamp;
    if (timestamp) lastEventAt = timestamp;

    if (event.event === "placement.accepted") {
      const shardId = stringValue(event.placedShardId) ?? stringValue(event.shardId);
      if (shardId) placementCounts.set(shardId, (placementCounts.get(shardId) ?? 0) + 1);
    }
    if (event.event === "workload.phase.started") {
      phasesStarted.push(phaseLabel(event));
    }
    if (event.event === "workload.phase.completed") {
      const label = phaseLabel(event);
      phasesCompleted.push(label);
      const durationMs = numberValue(event.durationMs);
      if (durationMs !== undefined) {
        const phase = phaseName(label);
        const durations = completedPhaseDurations.get(phase) ?? [];
        durations.push(durationMs);
        completedPhaseDurations.set(phase, durations);
      }
    }
    if (event.event === "workload.session.closed") {
      const code = scalarOrNull(event.code);
      const reason = closeReasonPrefix(stringValue(event.reason));
      const codeKey = code === undefined || code === null ? "<missing>" : String(code);
      closeCodeCounts.set(codeKey, (closeCodeCounts.get(codeKey) ?? 0) + 1);
      closeReasonCounts.set(reason, (closeReasonCounts.get(reason) ?? 0) + 1);
    }
    if (String(event.event ?? "").includes("error") || event.error !== undefined) {
      errorEvents.push(`${String(event.event ?? "unknown")}: ${stringValue(event.error) ?? ""}`.trim());
    }
  }

  const result = resultPath ? await readScenarioResult(resultPath) : undefined;
  const durationMs = durationMsBetween(firstEventAt, lastEventAt);
  return {
    case_id: caseIdFromPath(historyPath, ".history.jsonl"),
    history_path: relative(root, historyPath),
    result_path: resultPath ? relative(root, resultPath) : undefined,
    history_events: historyEvents,
    parse_errors: parseErrors,
    placement_count: Array.from(placementCounts.values()).reduce((sum, count) => sum + count, 0),
    placement_distribution: Object.fromEntries(
      Array.from(placementCounts.entries()).sort(([left], [right]) => left.localeCompare(right)),
    ),
    observed_placement_shards: placementCounts.size,
    phases_started: phasesStarted,
    phases_completed: phasesCompleted,
    completed_phase_durations_ms: Object.fromEntries(
      Array.from(completedPhaseDurations.entries()).sort(([left], [right]) => left.localeCompare(right)),
    ),
    session_closed_count: Array.from(closeCodeCounts.values()).reduce((sum, count) => sum + count, 0),
    session_close_code_distribution: sortedCountRecord(closeCodeCounts),
    session_close_reason_distribution: sortedCountRecord(closeReasonCounts),
    error_events: errorEvents,
    first_event_at: firstEventAt,
    last_event_at: lastEventAt,
    duration_ms: durationMs,
    result_status: result?.status,
    failing_oracles: result?.failingOracles ?? [],
    attribution_sentence: result?.attributionSentence,
  };
}

async function readScenarioResult(
  path: string,
): Promise<
  | {
      readonly status: "pass" | "fail" | "error";
      readonly failingOracles: readonly string[];
      readonly attributionSentence?: string;
    }
  | undefined
> {
  const raw = await readFile(path, "utf8");
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (value["schema_version"] !== 1 || !SCENARIO_RESULT_KINDS.has(String(value["kind"] ?? ""))) {
    return undefined;
  }
  const oracles = isRecord(value["oracles"]) ? value["oracles"] : {};
  const failingOracles = Object.entries(oracles)
    .filter(([_name, oracle]) => isRecord(oracle) && (oracle["ok"] !== true || oracle["status"] !== "pass"))
    .map(([name]) => name);
  const attribution = isRecord(value["attribution"]) ? value["attribution"] : undefined;
  const error = stringValue(value["error"]);
  return {
    status: error ? "error" : failingOracles.length > 0 ? "fail" : "pass",
    failingOracles,
    attributionSentence: stringValue(attribution?.["sentence"]),
  };
}

async function summarizeMonitor(root: string, path: string | undefined): Promise<MonitorSummary | undefined> {
  if (!path) return undefined;
  if (path.endsWith(".tsv")) return summarizeTsvMonitor(root, path);
  const parseErrors: string[] = [];
  let snapshots = 0;
  let firstSnapshotAt: string | undefined;
  let lastSnapshotAt: string | undefined;
  let lastSnapshot: Record<string, unknown> | undefined;

  for await (const { line, lineNumber } of readNonEmptyLines(path)) {
    let snapshot: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) throw new Error("monitor line must be a JSON object");
      snapshot = parsed;
    } catch (err) {
      parseErrors.push(`${relative(root, path)}:${lineNumber}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    snapshots += 1;
    const timestamp = stringValue(snapshot["ts"]);
    if (timestamp && !firstSnapshotAt) firstSnapshotAt = timestamp;
    if (timestamp) lastSnapshotAt = timestamp;
    lastSnapshot = snapshot;
  }

  const histories = Array.isArray(lastSnapshot?.["histories"]) ? lastSnapshot["histories"] : [];
  const lastHistoryRows = histories.filter(isRecord);
  const lastShards = isRecord(lastSnapshot?.["shards"]) ? lastSnapshot["shards"] : undefined;
  return {
    path: relative(root, path),
    snapshots,
    parse_errors: parseErrors,
    first_snapshot_at: firstSnapshotAt,
    last_snapshot_at: lastSnapshotAt,
    last_process_alive: booleanValue(lastSnapshot?.["processAlive"]),
    last_exit_code: scalarOrNull(lastSnapshot?.["exitCode"]),
    last_shard_count: numberValue(lastShards?.["count"]),
    last_active_games: numberValue(lastShards?.["total"]),
    last_failures: sumNumeric(lastHistoryRows, "failures"),
    last_session_closed: sumNumeric(lastHistoryRows, "sessionClosed"),
    last_session_errors: sumNumeric(lastHistoryRows, "sessionErrors"),
  };
}

async function summarizeTsvMonitor(root: string, path: string): Promise<MonitorSummary> {
  const parseErrors: string[] = [];
  let snapshots = 0;
  let firstSnapshotAt: string | undefined;
  let lastSnapshotAt: string | undefined;
  let lastSnapshot: Readonly<Record<string, string>> | undefined;

  for await (const { line, lineNumber } of readNonEmptyLines(path)) {
    try {
      const snapshot = parseMonitorTsvLine(line);
      snapshots += 1;
      const timestamp = snapshot["ts"];
      if (timestamp && !firstSnapshotAt) firstSnapshotAt = timestamp;
      if (timestamp) lastSnapshotAt = timestamp;
      lastSnapshot = snapshot;
    } catch (err) {
      parseErrors.push(`${relative(root, path)}:${lineNumber}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const shardSnapshot = lastSnapshotAt
    ? await readMonitorShardSnapshot(join(dirname(path), `shards-${lastSnapshotAt}.json`))
    : undefined;

  return {
    path: relative(root, path),
    snapshots,
    parse_errors: parseErrors,
    first_snapshot_at: firstSnapshotAt,
    last_snapshot_at: lastSnapshotAt,
    last_process_alive: booleanString(lastSnapshot?.["alive"]),
    last_exit_code: lastSnapshot?.["exit"] ? lastSnapshot["exit"] : undefined,
    last_shard_count: shardSnapshot?.count,
    last_active_games: shardSnapshot?.total,
    last_failures: intString(lastSnapshot?.["failures"]),
    last_session_closed: intString(lastSnapshot?.["closes"]),
    last_session_errors: intString(lastSnapshot?.["errors"]),
    last_capacity_warnings: intString(lastSnapshot?.["capacity_warnings"]),
    last_budget_rejects: intString(lastSnapshot?.["budget_rejects"]),
  };
}

function parseMonitorTsvLine(line: string): Readonly<Record<string, string>> {
  const parts = line.trim().split(/\s+/);
  const ts = parts.shift();
  if (!ts) throw new Error("monitor line missing timestamp");
  const out: Record<string, string> = { ts };
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator < 0) throw new Error(`monitor field missing '=': ${part}`);
    out[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return out;
}

async function readMonitorShardSnapshot(
  path: string,
): Promise<{ readonly count: number; readonly total: number } | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const rows = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed["shards"])
        ? parsed["shards"]
        : undefined;
    if (!rows) return undefined;
    const rowRecords = rows.filter(isRecord);
    return {
      count: rowRecords.length,
      total: rowRecords.reduce(
        (sum, row) =>
          sum +
          (numberValue(row["activeGames"]) ??
            numberValue(row["active_games"]) ??
            numberValue(row["currentGameCount"]) ??
            0),
        0,
      ),
    };
  } catch (err) {
    if (isErrorWithCode(err) && err.code === "ENOENT") return undefined;
    throw err;
  }
}

function gateFailuresFor(
  options: CliOptions,
  cases: readonly CaseSummary[],
  monitor: MonitorSummary | undefined,
  runExitCode: string | undefined,
): readonly string[] {
  const failures: string[] = [];
  if (options.expectCases !== undefined && cases.length !== options.expectCases) {
    failures.push(`expected exactly ${options.expectCases} case(s), saw ${cases.length}`);
  }
  if (options.expectCaseIds.length > 0) {
    const seen = new Set(cases.map((entry) => entry.case_id));
    const missing = options.expectCaseIds.filter((caseId) => !seen.has(caseId));
    if (missing.length > 0) failures.push(`missing expected case(s): ${missing.join(", ")}`);
  }
  if (options.requireResults) {
    const missing = cases.filter((entry) => !entry.result_path).map((entry) => entry.case_id);
    if (missing.length > 0) failures.push(`missing result files for ${missing.join(", ")}`);
  }
  if (options.expectExitCode !== undefined && runExitCode !== options.expectExitCode) {
    failures.push(`expected exit.code ${options.expectExitCode}, saw ${runExitCode ?? "<missing>"}`);
  } else if (options.expectExitCode === undefined && runExitCode !== undefined && runExitCode !== "0") {
    failures.push(`run exited non-zero: ${runExitCode}`);
  }
  if (options.expectTargetGames !== undefined) {
    for (const entry of cases) {
      if (entry.placement_count < options.expectTargetGames) {
        failures.push(
          `${entry.case_id} expected ${options.expectTargetGames} placements, saw ${entry.placement_count}`,
        );
      }
    }
  }
  for (const entry of cases) {
    if (entry.parse_errors.length > 0) failures.push(`${entry.case_id} has parse errors`);
    if (entry.error_events.length > 0) failures.push(`${entry.case_id} has error events`);
    if (entry.result_path && entry.result_status === undefined) {
      failures.push(`${entry.case_id} has an unrecognized result file`);
    }
    if (entry.result_status === "fail") failures.push(`${entry.case_id} has failing oracles`);
    if (entry.result_status === "error") failures.push(`${entry.case_id} errored`);
    if (
      options.expectPlacementShards !== undefined &&
      entry.observed_placement_shards < options.expectPlacementShards
    ) {
      failures.push(
        `${entry.case_id} expected placements on at least ${options.expectPlacementShards} shard(s), saw ${
          entry.observed_placement_shards
        }`,
      );
    }
    if (options.expectMinCaseDurationMs !== undefined) {
      if (entry.duration_ms === undefined) {
        failures.push(`${entry.case_id} missing measurable case duration`);
      } else if (entry.duration_ms < options.expectMinCaseDurationMs) {
        failures.push(
          `${entry.case_id} expected at least ${options.expectMinCaseDurationMs}ms duration, saw ${entry.duration_ms}ms`,
        );
      }
    }
    for (const [phase, expectedDurationMs] of Object.entries(options.expectMinPhaseDurationMs)) {
      const observedDurations = entry.completed_phase_durations_ms[phase] ?? [];
      const observedMax = observedDurations.length > 0 ? Math.max(...observedDurations) : undefined;
      if (observedMax === undefined) {
        failures.push(`${entry.case_id} missing completed ${phase} duration`);
      } else if (observedMax < expectedDurationMs) {
        failures.push(
          `${entry.case_id} expected completed ${phase} duration at least ${expectedDurationMs}ms, saw ${observedMax}ms`,
        );
      }
    }
    if (options.expectCompletedPhases.length > 0) {
      const completed = new Set(entry.phases_completed.map(phaseName));
      const missing = options.expectCompletedPhases.filter((phase) => !completed.has(phase));
      if (missing.length > 0) {
        failures.push(`${entry.case_id} missing completed phase(s): ${missing.join(", ")}`);
      }
    }
  }
  if (monitor && monitor.parse_errors.length > 0) {
    failures.push(`${monitor.path} has parse errors`);
  }
  if ((monitor?.last_failures ?? 0) > 0) {
    failures.push(`${monitor.path} observed ${monitor?.last_failures} workload failure(s)`);
  }
  const monitorExitCode = monitor?.last_exit_code;
  if (
    options.expectExitCode === undefined &&
    monitorExitCode !== undefined &&
    monitorExitCode !== null &&
    String(monitorExitCode) !== "0"
  ) {
    failures.push(`${monitor?.path} observed non-zero exit code ${monitorExitCode}`);
  }
  return failures;
}

async function listFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function* readNonEmptyLines(
  path: string,
): AsyncGenerator<{ readonly line: string; readonly lineNumber: number }> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim().length === 0) continue;
      yield { line, lineNumber };
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return raw.trim();
  } catch (err) {
    if (isErrorWithCode(err) && err.code === "ENOENT") return undefined;
    throw err;
  }
}

function caseIdFromPath(path: string, suffix: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.endsWith(suffix) ? base.slice(0, -suffix.length) : base;
}

function phaseLabel(event: HistoryEvent): string {
  const index = typeof event.phaseIndex === "number" ? `${event.phaseIndex}:` : "";
  return `${index}${stringValue(event.phaseType) ?? "unknown"}`;
}

function phaseName(label: string): string {
  const colon = label.indexOf(":");
  return colon >= 0 ? label.slice(colon + 1) : label;
}

function closeReasonPrefix(reason: string | undefined): string {
  if (!reason) return "<empty>";
  const hashIndex = reason.indexOf("#");
  return hashIndex >= 0 ? reason.slice(0, hashIndex) : reason;
}

function sortedCountRecord(counts: ReadonlyMap<string, number>): Readonly<Record<string, number>> {
  return Object.fromEntries(Array.from(counts.entries()).sort(([left], [right]) => left.localeCompare(right)));
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) throw new Error(`unexpected positional argument: ${arg ?? ""}`);
    if (arg === "--require-results") {
      values.set("require-results", true);
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg.slice(2), value);
    i += 1;
  }
  const soakDir = stringOption(values, "soak-dir") ?? "var/phase-5/soak";
  return {
    soakDir,
    outputPath: stringOption(values, "output") ?? join(soakDir, "soak-summary.json"),
    expectCaseIds: stringListOption(values, "expect-case-ids"),
    expectCases: positiveIntOption(values, "expect-cases"),
    expectTargetGames: positiveIntOption(values, "expect-target-games"),
    expectPlacementShards: positiveIntOption(values, "expect-placement-shards"),
    expectMinCaseDurationMs: positiveIntOption(values, "expect-min-case-duration-ms"),
    expectMinPhaseDurationMs: phaseDurationOption(values, "expect-min-phase-duration-ms"),
    expectCompletedPhases: stringListOption(values, "expect-completed-phases"),
    expectExitCode: stringOption(values, "expect-exit-code"),
    requireResults: values.get("require-results") === true,
  };
}

function durationMsBetween(
  firstTimestamp: string | undefined,
  lastTimestamp: string | undefined,
): number | undefined {
  if (!firstTimestamp || !lastTimestamp) return undefined;
  const firstMs = Date.parse(firstTimestamp);
  const lastMs = Date.parse(lastTimestamp);
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs)) return undefined;
  return lastMs - firstMs;
}

function stringOption(values: ReadonlyMap<string, string | true>, key: string): string | undefined {
  const value = values.get(key);
  return typeof value === "string" ? value : undefined;
}

function positiveIntOption(
  values: ReadonlyMap<string, string | true>,
  key: string,
): number | undefined {
  const value = stringOption(values, key);
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${key} must be a positive integer`);
  }
  return parsed;
}

function stringListOption(values: ReadonlyMap<string, string | true>, key: string): readonly string[] {
  const value = stringOption(values, key);
  if (value === undefined) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function phaseDurationOption(
  values: ReadonlyMap<string, string | true>,
  key: string,
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const entry of stringListOption(values, key)) {
    const [phase, rawDuration, extra] = entry.split("=");
    if (!phase || !rawDuration || extra !== undefined) {
      throw new Error(`--${key} entries must use phase=milliseconds`);
    }
    const durationMs = Number.parseInt(rawDuration, 10);
    if (!Number.isInteger(durationMs) || durationMs < 1) {
      throw new Error(`--${key} duration for ${phase} must be a positive integer`);
    }
    result[phase] = durationMs;
  }
  return result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function scalarOrNull(value: unknown): string | number | null | undefined {
  if (value === null) return null;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function intString(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function booleanString(value: string | undefined): boolean | undefined {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

function sumNumeric(rows: readonly Record<string, unknown>[], key: string): number | undefined {
  if (rows.length === 0) return undefined;
  return rows.reduce((sum, row) => sum + (numberValue(row[key]) ?? 0), 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isErrorWithCode(value: unknown): value is { readonly code: string } {
  return isRecord(value) && typeof value["code"] === "string";
}
