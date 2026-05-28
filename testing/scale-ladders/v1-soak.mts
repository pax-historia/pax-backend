import type { ScaleLadderPlan } from "@pax-backend/scenario-runner";

export default {
  schemaVersion: 1,
  ladderId: "phase-5-v1-soak",
  description:
    "Phase 5 exit soak: 1000 concurrent games across 10 shard machines for a 24-hour full-nemesis-suite window.",
  scenarioCatalogDir: "testing/scenarios",
  nemesisCatalogDir: "testing/nemeses",
  defaultScenarioId: "chat-steady-state",
  defaultMode: "load",
  defaultBackend: "live",
  defaultOracleScope: "scenario",
  rungs: [
    {
      rungId: "1000g-10shards-24h-suite",
      concurrentGames: 1000,
      shardMachines: 10,
      targetDurationMs: 28_800_000,
      rampMs: 600_000,
      sessionsPerGame: 1,
      nemesisIds: ["no-faults", "shard-death-every-5m", "api-kind-partition-burst"],
      samplingProfile: "cliff_hold",
      notes:
        "Three 8-hour nemesis cases form one 24-hour exit-soak suite at the v1 target.",
    },
  ],
} satisfies ScaleLadderPlan;
