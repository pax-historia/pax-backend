import { dirname, isAbsolute, join, resolve } from "node:path";

import type {
  ResolvedWorkloadFixture,
  ScenarioManifest,
  ScenarioRunnerInput,
  ScenarioRuntimeEnvironment,
  ScenarioWorkloadPlan,
  WorkloadFixture,
} from "./types.mjs";

export function buildScenarioRuntimeEnvironment(
  input: ScenarioRunnerInput,
  scenario: ScenarioManifest,
  workload: ScenarioWorkloadPlan,
): ScenarioRuntimeEnvironment {
  const fixtureBaseDir = resolveFixtureBaseDir(input, scenario);
  const fixtures = workload.fixtures.map((fixture) =>
    resolveWorkloadFixture(fixture, fixtureBaseDir),
  );
  const apiResponseFixtures = fixtures.filter((fixture) => fixture.kind === "api-responses");
  if (apiResponseFixtures.length > 1) {
    throw new Error(
      `${scenario.scenarioId} has multiple api-responses fixtures; use one directory fixture so it can map to PAX_API_REPLAY_FIXTURES_PATH`,
    );
  }

  const env: Record<string, string> = {};
  const apiReplayFixturesPath = apiResponseFixtures[0]?.absolutePath;
  if (apiReplayFixturesPath) {
    env["PAX_API_REPLAY_FIXTURES_PATH"] = apiReplayFixturesPath;
  }

  return {
    fixtureBaseDir,
    fixtures,
    env,
    apiReplayFixturesPath,
  };
}

function resolveFixtureBaseDir(
  input: ScenarioRunnerInput,
  scenario: ScenarioManifest,
): string {
  if (input.fixtureBaseDir) return resolvePath(input.fixtureBaseDir);
  if (input.scenarioManifestPath) return dirname(resolvePath(input.scenarioManifestPath));
  return join(resolvePath(input.scenarioCatalogDir ?? "testing/scenarios"), scenario.scenarioId);
}

function resolveWorkloadFixture(
  fixture: WorkloadFixture,
  fixtureBaseDir: string,
): ResolvedWorkloadFixture {
  return {
    ...fixture,
    absolutePath: isAbsolute(fixture.path) ? fixture.path : resolve(fixtureBaseDir, fixture.path),
  };
}

function resolvePath(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}
