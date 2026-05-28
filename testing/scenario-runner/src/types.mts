import type { OracleResult } from "@pax-backend/oracles-lib";

export type ScenarioRunMode = "load" | "property" | "fuzz" | "replay";
export type ScenarioBackend = "live" | "mock-shard" | "in-memory";
export type DeterminismLevel = "low" | "medium" | "high";
export type OracleScope = "all" | "scenario" | "explicit";
export type SamplingProfile = "ramp" | "cliff_hold" | "replay";
export type NemesisKind = "no-faults" | "shard-death-every-5m";

export interface ScenarioManifest {
  readonly scenarioId: string;
  readonly seed: string;
  readonly determinism: DeterminismLevel;
  readonly defaultMode: ScenarioRunMode;
  readonly defaultBackend: ScenarioBackend;
  readonly defaultNemesis: NemesisKind;
  readonly description: string;
  readonly oracleNames: readonly string[];
}

export interface NemesisManifest {
  readonly nemesisId: NemesisKind;
  readonly description: string;
  readonly actions: readonly NemesisAction[];
}

export type NemesisAction =
  | {
      readonly type: "none";
    }
  | {
      readonly type: "kill-shard";
      readonly everyMs: number;
      readonly selection: "round-robin" | "least-recently-killed";
      readonly replacement: "let-orchestrator-replace";
    };

export interface ScenarioRunnerInput {
  readonly scenarioId: string;
  readonly mode: ScenarioRunMode;
  readonly backend: ScenarioBackend;
  readonly historyPath: string;
  readonly runId?: string;
  readonly workerCount?: number;
  readonly nemesisId?: NemesisKind;
  readonly scenarioCatalogDir?: string;
  readonly nemesisCatalogDir?: string;
  readonly scenarioManifestPath?: string;
  readonly nemesisProfilePath?: string;
  readonly scenarioManifest?: ScenarioManifest;
  readonly nemesisManifest?: NemesisManifest;
  readonly oracleScope?: OracleScope;
  readonly oracleNames?: readonly string[];
  readonly samplingProfile?: SamplingProfile;
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
  readonly scenario: {
    readonly seed: string;
    readonly determinism: DeterminismLevel;
    readonly default_mode: ScenarioRunMode;
    readonly default_backend: ScenarioBackend;
    readonly primary_oracle_names: readonly string[];
    readonly description: string;
  };
  readonly nemesis: {
    readonly nemesis_id: NemesisKind;
    readonly description: string;
    readonly actions: readonly NemesisAction[];
  };
  readonly oracle_scope: OracleScope;
  readonly sampling_profile: SamplingProfile;
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
