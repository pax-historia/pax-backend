import type { Oracle, OracleResult } from "@pax-backend/oracles-lib";

export type ScenarioRunMode = "load" | "property" | "fuzz" | "replay";
export type ScenarioBackend = "live" | "mock-shard" | "in-memory";
export type DeterminismLevel = "low" | "medium" | "high";
export type OracleScope = "all" | "scenario" | "explicit";
export type SamplingProfile = "ramp" | "cliff_hold" | "replay";
export type NemesisKind = "no-faults" | "shard-death-every-5m";
export type WorkloadFixtureKind =
  | "allowed-players"
  | "initial-state"
  | "initial-blob"
  | "api-responses";

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

export interface ScenarioWorkloadPlan {
  readonly scenarioId: string;
  readonly bundleName: string;
  readonly gameIdPrefix: string;
  readonly durationMs: number;
  readonly maxGames: number;
  readonly fixtures: readonly WorkloadFixture[];
  readonly phases: readonly ScenarioWorkloadPhase[];
}

export interface WorkloadFixture {
  readonly kind: WorkloadFixtureKind;
  readonly path: string;
}

export interface ResolvedWorkloadFixture extends WorkloadFixture {
  readonly absolutePath: string;
}

export interface ScenarioRuntimeEnvironment {
  readonly fixtureBaseDir: string;
  readonly fixtures: readonly ResolvedWorkloadFixture[];
  readonly env: Readonly<Record<string, string>>;
  readonly apiReplayFixturesPath?: string;
}

export interface ApiKindWorkloadRegistration {
  readonly kindName: string;
  readonly url: string;
}

export type ScenarioWorkloadPhase =
  | {
      readonly type: "seed-fixtures";
      readonly fixtureKinds: readonly WorkloadFixtureKind[];
    }
  | {
      readonly type: "register-api-kinds";
      readonly kinds: readonly ApiKindWorkloadRegistration[];
    }
  | {
      readonly type: "open-sessions";
      readonly playerSource: "allowed-players";
      readonly sessionsPerGame: number;
      readonly rampMs: number;
    }
  | {
      readonly type: "send-json";
      readonly channel: "websocket";
      readonly messagesPerSession: number;
      readonly intervalMs: number;
      readonly fanoutMs?: number;
      readonly body: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "invoke-api";
      readonly kind: string;
      readonly callsPerSession: number;
      readonly intervalMs: number;
      readonly args: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "state-blob-churn";
      readonly stateWritesPerMinute: number;
      readonly blobWritesPerMinute: number;
      readonly bytesPerWrite: number;
    }
  | {
      readonly type: "send-host-events";
      readonly eventType: string;
      readonly payload: Readonly<Record<string, unknown>>;
      readonly wakeOnDelivery: boolean;
      readonly targetGameCount: number;
    }
  | {
      readonly type: "flip-bundles";
      readonly newBundleName: string;
      readonly targetGameCount: number;
    }
  | {
      readonly type: "sleep-wake";
      readonly cycles: number;
      readonly idleMsBetweenCycles: number;
    }
  | {
      readonly type: "await-nemesis";
      readonly action: "kill-shard";
      readonly minimumOccurrences: number;
    }
  | {
      readonly type: "expect-history-events";
      readonly events: readonly string[];
      readonly minimumPerGame: number;
    }
  | {
      readonly type: "wait";
      readonly durationMs: number;
    }
  | {
      readonly type: "close-sessions";
      readonly reason: string;
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
  readonly workloadPath?: string;
  readonly workloadPlan?: ScenarioWorkloadPlan;
  readonly workloadGameIdPrefix?: string;
  readonly fixtureBaseDir?: string;
  readonly runtimeEnvironment?: ScenarioRuntimeEnvironment;
  readonly controlPlaneUrl?: string;
  readonly routerUrl?: string;
  readonly phaseTimeoutMs?: number;
  readonly metrics?: ScenarioMetrics;
  readonly attribution?: ScenarioAttribution;
  readonly oracleScope?: OracleScope;
  readonly oracleNames?: readonly string[];
  readonly scenarioLocalOracles?: readonly Oracle[];
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

export interface ScenarioMetrics {
  readonly per_surface: Readonly<Record<string, unknown>>;
}

export interface ScenarioAttribution {
  readonly sentence: string;
  readonly candidates: readonly AttributionCandidate[];
  readonly falsified: readonly AttributionCandidate[];
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
  readonly workload?: {
    readonly bundle_name: string;
    readonly game_id_prefix: string;
    readonly duration_ms: number;
    readonly max_games: number;
    readonly fixtures: readonly WorkloadFixture[];
    readonly phases: readonly ScenarioWorkloadPhase[];
  };
  readonly runtime_environment?: {
    readonly fixture_base_dir: string;
    readonly fixtures: readonly ResolvedWorkloadFixture[];
    readonly env: Readonly<Record<string, string>>;
    readonly api_replay_fixtures_path?: string;
  };
  readonly oracle_scope: OracleScope;
  readonly sampling_profile: SamplingProfile;
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number;
  readonly worker_count: number;
  readonly worker_artifacts: readonly WorkerArtifact[];
  readonly metrics: ScenarioMetrics;
  readonly attribution: ScenarioAttribution;
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
