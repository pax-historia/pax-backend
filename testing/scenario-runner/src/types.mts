import type { Oracle, OracleResult } from "@pax-backend/oracles-lib";

export type ScenarioRunMode = "load" | "property" | "fuzz" | "replay";
export type ScenarioBackend = "live" | "mock-shard" | "in-memory";
export type ScenarioRuntimeKind = "ivm" | "noivm";
export type DeterminismLevel = "low" | "medium" | "high";
export type OracleScope = "all" | "scenario" | "explicit";
export type SamplingProfile = "ramp" | "cliff_hold" | "replay";
export type NemesisKind =
  | "no-faults"
  | "shard-death-every-5m"
  | "api-kind-partition-burst";
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
    }
  | {
      readonly type: "api-kind-partition";
      readonly afterMs: number;
      readonly durationMs: number;
      readonly kindName: string;
      readonly partitionUrl: string;
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

export interface WsRefusalAttempt {
  readonly placementGameIndex: number;
  readonly connectGameIndex?: number;
  readonly playerId: string;
  readonly tokenMutation?: "none" | "tamper-signature" | "expire-token";
  readonly expectedCode?: number;
  readonly expectedCodes?: readonly number[];
  readonly expectedReasonIncludes?: string;
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
      readonly type: "expect-ws-refusals";
      readonly attempts: readonly WsRefusalAttempt[];
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
      readonly action: "kill-shard" | "api-kind-partition";
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
  readonly workloadMaxGames?: number;
  readonly workloadDurationMs?: number;
  readonly workloadSessionsPerGame?: number;
  readonly workloadOpenSessionsRampMs?: number;
  readonly workloadSendJsonMessagesPerSession?: number;
  readonly workloadSendJsonIntervalMs?: number;
  readonly workloadSendJsonFanoutMs?: number;
  readonly fixtureBaseDir?: string;
  readonly runtimeEnvironment?: ScenarioRuntimeEnvironment;
  readonly controlPlaneUrl?: string;
  readonly apiGatewayUrl?: string;
  readonly routerUrl?: string;
  readonly phaseTimeoutMs?: number;
  readonly metrics?: ScenarioMetrics;
  readonly attribution?: ScenarioAttribution;
  readonly extraOracleResults?: readonly OracleResult[];
  readonly metricsScrapeIntervalMs?: number;
  readonly oracleScope?: OracleScope;
  readonly oracleNames?: readonly string[];
  readonly scenarioLocalOracles?: readonly Oracle[];
  readonly samplingProfile?: SamplingProfile;
}

export interface ScenarioSuiteRunnerInput {
  readonly scenarioCatalogDir?: string;
  readonly nemesisCatalogDir?: string;
  readonly scenarioIds?: readonly string[];
  readonly nemesisIds?: readonly NemesisKind[];
  readonly runtimeKind: ScenarioRuntimeKind;
  readonly outputDir: string;
  readonly mode?: ScenarioRunMode;
  readonly backend?: ScenarioBackend;
  readonly workerCount?: number;
  readonly controlPlaneUrl?: string;
  readonly apiGatewayUrl?: string;
  readonly routerUrl?: string;
  readonly phaseTimeoutMs?: number;
  readonly metricsScrapeIntervalMs?: number;
  readonly oracleScope?: OracleScope;
  readonly oracleNames?: readonly string[];
  readonly samplingProfile?: SamplingProfile;
}

export interface ScenarioSuiteCaseSummary {
  readonly scenario_id: string;
  readonly nemesis_id: NemesisKind;
  readonly runtime_kind: ScenarioRuntimeKind;
  readonly mode: ScenarioRunMode;
  readonly backend: ScenarioBackend;
  readonly status: "pass" | "fail" | "error";
  readonly history_path: string;
  readonly result_path?: string;
  readonly duration_ms: number;
  readonly failing_oracles: readonly string[];
  readonly error?: string;
}

export interface ScenarioSuiteResult {
  readonly schema_version: 1;
  readonly kind: "scenario-suite";
  readonly runtime_kind: ScenarioRuntimeKind;
  readonly scenario_catalog_dir: string;
  readonly nemesis_catalog_dir: string;
  readonly output_dir: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly errored: number;
  };
  readonly cases: readonly ScenarioSuiteCaseSummary[];
}

export interface ScaleLadderPlan {
  readonly schemaVersion: 1;
  readonly ladderId: string;
  readonly description: string;
  readonly scenarioCatalogDir?: string;
  readonly nemesisCatalogDir?: string;
  readonly defaultScenarioId: string;
  readonly defaultMode?: ScenarioRunMode;
  readonly defaultBackend?: ScenarioBackend;
  readonly defaultOracleScope?: OracleScope;
  readonly rungs: readonly ScaleRungSpec[];
}

export interface ScaleRungSpec {
  readonly rungId: string;
  readonly concurrentGames: number;
  readonly shardMachines: number;
  readonly targetDurationMs: number;
  readonly rampMs: number;
  readonly sessionsPerGame: number;
  readonly sendJsonIntervalMs?: number;
  readonly sendJsonFanoutMs?: number;
  readonly scenarioId?: string;
  readonly nemesisIds: readonly NemesisKind[];
  readonly samplingProfile?: SamplingProfile;
  readonly workerCount?: number;
  readonly notes?: string;
}

export interface ScenarioScaleRunnerInput {
  readonly scalePlanPath: string;
  readonly outputDir: string;
  readonly runtimeKind: ScenarioRuntimeKind;
  readonly rungIds?: readonly string[];
  readonly nemesisIds?: readonly NemesisKind[];
  readonly scenarioCatalogDir?: string;
  readonly nemesisCatalogDir?: string;
  readonly mode?: ScenarioRunMode;
  readonly backend?: ScenarioBackend;
  readonly workerCount?: number;
  readonly controlPlaneUrl?: string;
  readonly apiGatewayUrl?: string;
  readonly routerUrl?: string;
  readonly phaseTimeoutMs?: number;
  readonly metricsScrapeIntervalMs?: number;
  readonly oracleScope?: OracleScope;
  readonly oracleNames?: readonly string[];
  readonly samplingProfile?: SamplingProfile;
}

export interface ScaleRungCaseSummary {
  readonly scenario_id: string;
  readonly nemesis_id: NemesisKind;
  readonly runtime_kind: ScenarioRuntimeKind;
  readonly mode: ScenarioRunMode;
  readonly backend: ScenarioBackend;
  readonly status: "pass" | "fail" | "error";
  readonly history_path: string;
  readonly result_path?: string;
  readonly duration_ms: number;
  readonly failing_oracles: readonly string[];
  readonly attribution_sentence?: string;
  readonly error?: string;
}

export interface ScaleRungResult {
  readonly schema_version: 1;
  readonly kind: "scale-rung";
  readonly ladder_id: string;
  readonly rung_id: string;
  readonly runtime_kind: ScenarioRuntimeKind;
  readonly scenario_id: string;
  readonly concurrent_games: number;
  readonly shard_machines: number;
  readonly sessions_per_game: number;
  readonly target_duration_ms: number;
  readonly ramp_ms: number;
  readonly send_json_interval_ms?: number;
  readonly send_json_fanout_ms?: number;
  readonly sampling_profile: SamplingProfile;
  readonly nemesis_ids: readonly NemesisKind[];
  readonly output_dir: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly errored: number;
  };
  readonly cases: readonly ScaleRungCaseSummary[];
  readonly attribution_sentences: readonly string[];
  readonly notes?: string;
}

export interface ScaleLadderResult {
  readonly schema_version: 1;
  readonly kind: "scale-ladder";
  readonly ladder_id: string;
  readonly description: string;
  readonly plan_path: string;
  readonly output_dir: string;
  readonly runtime_kind: ScenarioRuntimeKind;
  readonly started_at: string;
  readonly finished_at: string;
  readonly duration_ms: number;
  readonly summary: {
    readonly total_rungs: number;
    readonly passed_rungs: number;
    readonly failed_rungs: number;
    readonly errored_rungs: number;
    readonly total_cases: number;
    readonly passed_cases: number;
    readonly failed_cases: number;
    readonly errored_cases: number;
  };
  readonly rungs: readonly ScaleRungResult[];
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
  readonly scrape?: ScenarioMetricsScrapeSummary;
}

export interface ScenarioMetricsScrapeSummary {
  readonly started_at: string;
  readonly finished_at: string;
  readonly interval_ms: number;
  readonly endpoints: readonly {
    readonly surface: string;
    readonly url: string;
  }[];
  readonly sample_count: number;
  readonly dropped_sample_count?: number;
  readonly error_count: number;
  readonly errors: readonly {
    readonly surface: string;
    readonly url: string;
    readonly sampled_at: string;
    readonly error: string;
  }[];
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
