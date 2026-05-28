import type { OracleResult } from "@pax-backend/oracles-lib";

export type ScenarioRunMode = "load" | "property" | "fuzz" | "replay";
export type ScenarioBackend = "live" | "mock-shard" | "in-memory";
export type DeterminismLevel = "low" | "medium" | "high";

export interface ScenarioManifest {
  readonly scenarioId: string;
  readonly seed: string;
  readonly determinism: DeterminismLevel;
  readonly defaultMode: ScenarioRunMode;
  readonly defaultBackend: ScenarioBackend;
  readonly description: string;
  readonly oracleNames: readonly string[];
}

export interface ScenarioRunnerInput {
  readonly scenarioId: string;
  readonly mode: ScenarioRunMode;
  readonly backend: ScenarioBackend;
  readonly historyPath: string;
  readonly runId?: string;
  readonly workerCount?: number;
}

export interface WorkerArtifact {
  readonly path: string;
  readonly summary: Readonly<Record<string, unknown>>;
}

export interface AttributionCandidate {
  readonly subsystem: string;
  readonly metric: string;
  readonly rank: number;
  readonly p99_ms?: number;
  readonly note?: string;
}

export interface ScenarioResult {
  readonly schema_version: 1;
  readonly kind: ScenarioRunMode;
  readonly scenario_id: string;
  readonly run_id: string;
  readonly backend: ScenarioBackend;
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number;
  readonly worker_count: number;
  readonly worker_artifacts: readonly WorkerArtifact[];
  readonly metrics: {
    readonly per_surface: Readonly<Record<string, unknown>>;
  };
  readonly attribution: {
    readonly sentence: string;
    readonly candidates: readonly AttributionCandidate[];
    readonly falsified: readonly AttributionCandidate[];
  };
  readonly oracles: Readonly<Record<string, ScenarioOracleSummary>>;
  readonly history_url?: string;
  readonly trace_links: readonly string[];
}

export interface ScenarioOracleSummary {
  readonly ok: boolean;
  readonly status: OracleResult["status"];
  readonly checkedEvents: number;
  readonly violations: readonly unknown[];
}
