import type { ScaleLadderPlan } from "@pax-backend/scenario-runner";

const steadyHoldSendJson = {
  sendJsonIntervalMs: 60_000,
  sendJsonFanoutMs: 30_000,
} as const;

export default {
  schemaVersion: 1,
  ladderId: "phase-9-topology-proof",
  description:
    "Phase 9 Fly topology proof: 100 concurrent games across three Broker shard machines for 30 minutes.",
  scenarioCatalogDir: "testing/scenarios",
  nemesisCatalogDir: "testing/nemeses",
  defaultScenarioId: "chat-steady-state",
  defaultMode: "load",
  defaultBackend: "live",
  defaultOracleScope: "scenario",
  rungs: [
    {
      rungId: "100g-3shards-30m-topology",
      concurrentGames: 100,
      shardMachines: 3,
      targetDurationMs: 1_800_000,
      rampMs: 120_000,
      sessionsPerGame: 1,
      ...steadyHoldSendJson,
      nemesisIds: ["no-faults", "shard-death-every-5m"],
      samplingProfile: "ramp",
      notes:
        "Phase 9 exit proof: keeps the game count at the topology target while using multiple shard machines so placement distribution, Fly-Replay WS pinning, and shard-death recovery are all exercised.",
    },
  ],
} satisfies ScaleLadderPlan;
