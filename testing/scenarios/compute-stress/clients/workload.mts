import type { ScenarioWorkloadPlan } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "compute-stress",
  bundleName: "hello-multifeature",
  gameIdPrefix: "compute-stress",
  durationMs: 600_000,
  maxGames: 32,
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
      rampMs: 45_000,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 240,
      intervalMs: 500,
      body: { type: "stress", payloadBytes: 1024 },
    },
    {
      type: "invoke-api",
      kind: "mock-ai.v1",
      callsPerSession: 30,
      intervalMs: 2_000,
      args: { messages: [{ role: "user", content: "compute-stress" }] },
    },
    {
      type: "state-blob-churn",
      stateWritesPerMinute: 120,
      blobWritesPerMinute: 12,
      bytesPerWrite: 1024,
    },
    {
      type: "close-sessions",
      reason: "scenarioComplete",
    },
    {
      type: "expect-history-events",
      events: [
        "compute.budget",
        "api.invoke.request",
        "api.invoke.response",
        "state.write",
        "blob.write",
      ],
      minimumPerGame: 1,
    },
  ],
} satisfies ScenarioWorkloadPlan;
