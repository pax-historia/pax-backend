import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  NemesisManifest,
  ScenarioManifest,
  ScenarioRunnerInput,
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

function requireString(value: unknown, path: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} field ${field} must be a non-empty string`);
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
