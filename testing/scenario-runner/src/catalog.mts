import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  NemesisManifest,
  ScenarioManifest,
  ScenarioRunnerInput,
  ScenarioWorkloadPlan,
} from "./types.mjs";

export async function loadScenarioManifest(
  input: ScenarioRunnerInput,
): Promise<ScenarioManifest> {
  if (input.scenarioManifest) return input.scenarioManifest;
  const path = input.scenarioManifestPath
    ? resolvePath(input.scenarioManifestPath)
    : join(
        resolvePath(input.scenarioCatalogDir ?? "testing/scenarios"),
        input.scenarioId,
        "manifest.mts",
      );
  return validateScenarioManifest(await importDefault(path), path);
}

export async function loadNemesisManifest(
  input: ScenarioRunnerInput,
  scenario: ScenarioManifest,
): Promise<NemesisManifest> {
  if (input.nemesisManifest) return input.nemesisManifest;
  const nemesisId = input.nemesisId ?? scenario.defaultNemesis;
  const path = input.nemesisProfilePath
    ? resolvePath(input.nemesisProfilePath)
    : join(
        resolvePath(input.nemesisCatalogDir ?? "testing/nemeses"),
        nemesisId,
        "fault-profile.mts",
      );
  return validateNemesisManifest(await importDefault(path), path);
}

export async function loadScenarioWorkloadPlan(
  input: ScenarioRunnerInput,
  scenario: ScenarioManifest,
): Promise<ScenarioWorkloadPlan | undefined> {
  if (input.workloadPlan) return applyWorkloadOverrides(input, input.workloadPlan);
  const path = input.workloadPath
    ? resolvePath(input.workloadPath)
    : join(
        resolvePath(input.scenarioCatalogDir ?? "testing/scenarios"),
        scenario.scenarioId,
        "clients",
        "workload.mts",
      );
  if (!existsSync(path)) return undefined;
  const plan = validateScenarioWorkloadPlan(await importDefault(path), path);
  if (plan.scenarioId !== scenario.scenarioId) {
    throw new Error(`${path} scenarioId does not match ${scenario.scenarioId}`);
  }
  return applyWorkloadOverrides(input, plan);
}

function applyWorkloadOverrides(
  input: ScenarioRunnerInput,
  plan: ScenarioWorkloadPlan,
): ScenarioWorkloadPlan {
  if (!input.workloadGameIdPrefix) return plan;
  return { ...plan, gameIdPrefix: input.workloadGameIdPrefix };
}

async function importDefault(path: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(path).href)) as { default?: unknown };
  return mod.default;
}

function resolvePath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function validateScenarioManifest(value: unknown, path: string): ScenarioManifest {
  if (!isRecord(value)) throw new Error(`${path} must default-export a scenario manifest`);
  const manifest = value as Partial<ScenarioManifest>;
  requireString(manifest.scenarioId, path, "scenarioId");
  requireString(manifest.seed, path, "seed");
  requireString(manifest.description, path, "description");
  requireOneOf(manifest.determinism, path, "determinism", ["low", "medium", "high"]);
  requireOneOf(manifest.defaultMode, path, "defaultMode", ["load", "property", "fuzz", "replay"]);
  requireOneOf(manifest.defaultBackend, path, "defaultBackend", [
    "live",
    "mock-shard",
    "in-memory",
  ]);
  requireOneOf(manifest.defaultNemesis, path, "defaultNemesis", [
    "no-faults",
    "shard-death-every-5m",
  ]);
  if (!Array.isArray(manifest.oracleNames) || manifest.oracleNames.length === 0) {
    throw new Error(`${path} field oracleNames must be a non-empty array`);
  }
  for (const [index, oracle] of manifest.oracleNames.entries()) {
    requireString(oracle, path, `oracleNames[${index}]`);
  }
  return manifest as ScenarioManifest;
}

function validateNemesisManifest(value: unknown, path: string): NemesisManifest {
  if (!isRecord(value)) throw new Error(`${path} must default-export a nemesis manifest`);
  const manifest = value as Partial<NemesisManifest>;
  requireOneOf(manifest.nemesisId, path, "nemesisId", [
    "no-faults",
    "shard-death-every-5m",
  ]);
  requireString(manifest.description, path, "description");
  if (!Array.isArray(manifest.actions) || manifest.actions.length === 0) {
    throw new Error(`${path} field actions must be a non-empty array`);
  }
  for (const [index, action] of manifest.actions.entries()) {
    if (!isRecord(action)) {
      throw new Error(`${path} field actions[${index}] must be an object`);
    }
    if (action["type"] === "none") continue;
    if (action["type"] !== "kill-shard") {
      throw new Error(`${path} field actions[${index}].type is unsupported`);
    }
    if (typeof action["everyMs"] !== "number" || !Number.isFinite(action["everyMs"])) {
      throw new Error(`${path} field actions[${index}].everyMs must be finite`);
    }
  }
  return manifest as NemesisManifest;
}

function validateScenarioWorkloadPlan(value: unknown, path: string): ScenarioWorkloadPlan {
  if (!isRecord(value)) throw new Error(`${path} must default-export a workload plan`);
  const plan = value as Partial<ScenarioWorkloadPlan>;
  requireString(plan.scenarioId, path, "scenarioId");
  requireString(plan.bundleName, path, "bundleName");
  requireString(plan.gameIdPrefix, path, "gameIdPrefix");
  requirePositiveNumber(plan.durationMs, path, "durationMs");
  requirePositiveNumber(plan.maxGames, path, "maxGames");
  if (!Array.isArray(plan.fixtures)) {
    throw new Error(`${path} field fixtures must be an array`);
  }
  for (const [index, fixture] of plan.fixtures.entries()) {
    if (!isRecord(fixture)) {
      throw new Error(`${path} field fixtures[${index}] must be an object`);
    }
    requireOneOf(fixture["kind"], path, `fixtures[${index}].kind`, [
      "allowed-players",
      "initial-state",
      "initial-blob",
      "api-responses",
    ]);
    requireString(fixture["path"], path, `fixtures[${index}].path`);
  }
  if (!Array.isArray(plan.phases) || plan.phases.length === 0) {
    throw new Error(`${path} field phases must be a non-empty array`);
  }
  const phases: unknown[] = [];
  for (const [index, phase] of plan.phases.entries()) {
    phases.push(validateScenarioWorkloadPhase(phase, path, index));
  }
  return { ...plan, phases } as ScenarioWorkloadPlan;
}

function validateScenarioWorkloadPhase(value: unknown, path: string, index: number): unknown {
  const prefix = `phases[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${path} field ${prefix} must be an object`);
  }
  const rawType = value["type"] ?? value["phase"];
  if (typeof rawType !== "string") {
    throw new Error(`${path} field ${prefix}.type must be a string`);
  }
  const normalized = Object.prototype.hasOwnProperty.call(value, "type")
    ? value
    : { ...value, type: rawType };
  switch (rawType) {
    case "seed-fixtures":
      requireFixtureKindArray(value["fixtureKinds"], path, `${prefix}.fixtureKinds`);
      return normalized;
    case "register-api-kinds":
      if (!Array.isArray(value["kinds"])) {
        throw new Error(`${path} field ${prefix}.kinds must be an array`);
      }
      for (const [kindIndex, kind] of value["kinds"].entries()) {
        if (!isRecord(kind)) {
          throw new Error(`${path} field ${prefix}.kinds[${kindIndex}] must be an object`);
        }
        requireString(kind["kindName"], path, `${prefix}.kinds[${kindIndex}].kindName`);
        requireString(kind["url"], path, `${prefix}.kinds[${kindIndex}].url`);
      }
      return normalized;
    case "open-sessions":
      requireOneOf(value["playerSource"], path, `${prefix}.playerSource`, [
        "allowed-players",
      ]);
      requirePositiveNumber(value["sessionsPerGame"], path, `${prefix}.sessionsPerGame`);
      requireNonNegativeNumber(value["rampMs"], path, `${prefix}.rampMs`);
      return normalized;
    case "send-json":
      requireOneOf(value["channel"], path, `${prefix}.channel`, ["websocket"]);
      requirePositiveNumber(value["messagesPerSession"], path, `${prefix}.messagesPerSession`);
      requireNonNegativeNumber(value["intervalMs"], path, `${prefix}.intervalMs`);
      if (!isRecord(value["body"])) {
        throw new Error(`${path} field ${prefix}.body must be an object`);
      }
      return normalized;
    case "invoke-api":
      requireString(value["kind"], path, `${prefix}.kind`);
      requirePositiveNumber(value["callsPerSession"], path, `${prefix}.callsPerSession`);
      requireNonNegativeNumber(value["intervalMs"], path, `${prefix}.intervalMs`);
      if (!isRecord(value["args"])) {
        throw new Error(`${path} field ${prefix}.args must be an object`);
      }
      return normalized;
    case "state-blob-churn":
      requireNonNegativeNumber(value["stateWritesPerMinute"], path, `${prefix}.stateWritesPerMinute`);
      requireNonNegativeNumber(value["blobWritesPerMinute"], path, `${prefix}.blobWritesPerMinute`);
      requirePositiveNumber(value["bytesPerWrite"], path, `${prefix}.bytesPerWrite`);
      return normalized;
    case "send-host-events":
      requireString(value["eventType"], path, `${prefix}.eventType`);
      if (!isRecord(value["payload"])) {
        throw new Error(`${path} field ${prefix}.payload must be an object`);
      }
      if (typeof value["wakeOnDelivery"] !== "boolean") {
        throw new Error(`${path} field ${prefix}.wakeOnDelivery must be a boolean`);
      }
      requirePositiveNumber(value["targetGameCount"], path, `${prefix}.targetGameCount`);
      return normalized;
    case "flip-bundles":
      requireString(value["newBundleName"], path, `${prefix}.newBundleName`);
      requirePositiveNumber(value["targetGameCount"], path, `${prefix}.targetGameCount`);
      return normalized;
    case "sleep-wake":
      requirePositiveNumber(value["cycles"], path, `${prefix}.cycles`);
      requireNonNegativeNumber(value["idleMsBetweenCycles"], path, `${prefix}.idleMsBetweenCycles`);
      return normalized;
    case "await-nemesis":
      requireOneOf(value["action"], path, `${prefix}.action`, ["kill-shard"]);
      requirePositiveNumber(value["minimumOccurrences"], path, `${prefix}.minimumOccurrences`);
      return normalized;
    case "expect-history-events":
      requireStringArray(value["events"], path, `${prefix}.events`);
      requirePositiveNumber(value["minimumPerGame"], path, `${prefix}.minimumPerGame`);
      return normalized;
    case "wait":
      requireNonNegativeNumber(value["durationMs"], path, `${prefix}.durationMs`);
      return normalized;
    case "close-sessions":
      requireString(value["reason"], path, `${prefix}.reason`);
      return normalized;
    default:
      throw new Error(`${path} field ${prefix}.type is unsupported: ${rawType}`);
  }
}

function requireString(value: unknown, path: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} field ${field} must be a non-empty string`);
  }
}

function requirePositiveNumber(value: unknown, path: string, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} field ${field} must be a positive number`);
  }
}

function requireNonNegativeNumber(value: unknown, path: string, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} field ${field} must be a non-negative number`);
  }
}

function requireStringArray(value: unknown, path: string, field: string): void {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new Error(`${path} field ${field} must be a non-empty string array`);
  }
}

function requireFixtureKindArray(value: unknown, path: string, field: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} field ${field} must be a non-empty fixture kind array`);
  }
  for (const [index, kind] of value.entries()) {
    requireOneOf(kind, path, `${field}[${index}]`, [
      "allowed-players",
      "initial-state",
      "initial-blob",
      "api-responses",
    ]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
