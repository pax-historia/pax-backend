import type { ScenarioWorkloadPlan } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "shard-death-resilience",
  bundleName: "hello-blob-rw",
  gameIdPrefix: "shard-death",
  durationMs: 900_000,
  maxGames: 16,
  fixtures: [
    { kind: "allowed-players", path: "fixtures/allowed-players.json" },
    { kind: "initial-state", path: "fixtures/initial-state.json" },
    { kind: "initial-blob", path: "fixtures/initial-blob.json" },
  ],
  phases: [
    {
      type: "seed-fixtures",
      fixtureKinds: ["allowed-players", "initial-state", "initial-blob"],
    },
    {
      type: "open-sessions",
      playerSource: "allowed-players",
      sessionsPerGame: 2,
      rampMs: 30_000,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 60,
      intervalMs: 2_000,
      body: { type: "blob-marker", marker: "blob-survives-shard-loss" },
    },
    {
      type: "sleep-wake",
      cycles: 2,
      idleMsBetweenCycles: 90_000,
    },
    {
      type: "await-nemesis",
      action: "kill-shard",
      minimumOccurrences: 1,
    },
    {
      type: "close-sessions",
      reason: "scenarioComplete",
    },
    {
      type: "expect-history-events",
      events: ["blob.write", "blob.read", "lifecycle.sleepComplete"],
      minimumPerGame: 1,
    },
  ],
} satisfies ScenarioWorkloadPlan;
