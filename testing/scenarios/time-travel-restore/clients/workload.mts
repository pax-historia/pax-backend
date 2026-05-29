import type { ScenarioWorkloadPlan } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "time-travel-restore",
  bundleName: "checkpoint-skew-probe",
  gameIdPrefix: "time-travel-restore",
  durationMs: 90_000,
  maxGames: 1,
  fixtures: [
    { kind: "allowed-players", path: "fixtures/allowed-players.json" },
  ],
  phases: [
    {
      type: "seed-fixtures",
      fixtureKinds: ["allowed-players"],
    },
    {
      type: "open-sessions",
      playerSource: "allowed-players",
      sessionsPerGame: 1,
      rampMs: 0,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 1,
      intervalMs: 0,
      body: { type: "commit", marker: "first" },
    },
    {
      type: "expect-history-events",
      events: ["state.flush"],
      minimumPerGame: 1,
    },
    {
      type: "capture-checkpoint",
      targetGameCount: 1,
      alias: "first",
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 1,
      intervalMs: 0,
      body: { type: "commit", marker: "second" },
    },
    {
      type: "expect-history-events",
      events: ["state.flush"],
      minimumPerGame: 2,
    },
    {
      type: "expect-admin-snapshot",
      targetGameCount: 1,
      marker: "first",
      checkpointAlias: "first",
    },
    {
      type: "expect-admin-snapshot",
      targetGameCount: 1,
      marker: "second",
    },
    {
      type: "restore-checkpoint",
      targetGameCount: 1,
      checkpointAlias: "first",
    },
    {
      type: "expect-history-events",
      events: ["state.restore", "isolate.restart"],
      minimumPerGame: 1,
    },
    {
      type: "open-sessions",
      playerSource: "allowed-players",
      sessionsPerGame: 1,
      rampMs: 0,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 1,
      intervalMs: 0,
      body: { type: "probe", marker: "after-restore" },
    },
    {
      type: "wait",
      durationMs: 100,
    },
    {
      type: "close-sessions",
      reason: "scenarioComplete",
    },
  ],
} satisfies ScenarioWorkloadPlan;
