import type { ScenarioWorkloadPlan } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "compute-stress",
  bundleName: "hello-multifeature",
  gameIdPrefix: "phase2-no-fault",
  durationMs: 1_800_000,
  maxGames: 100,
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
      sessionsPerGame: 1,
      rampMs: 30_000,
    },
    {
      type: "send-host-events",
      eventType: "phase2.no_fault.marker",
      payload: { source: "phase2-no-fault" },
      wakeOnDelivery: true,
      targetGameCount: 100,
    },
    {
      type: "flip-bundles",
      newBundleName: "hello-multifeature",
      targetGameCount: 100,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 181,
      intervalMs: 10_000,
      body: { type: "phase2-no-fault", payloadBytes: 256 },
    },
    {
      type: "close-sessions",
      reason: "scenarioComplete",
    },
    {
      type: "wait",
      durationMs: 90_000,
    },
  ],
} satisfies ScenarioWorkloadPlan;
