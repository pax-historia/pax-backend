import type { ScenarioWorkloadPlan } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "checkpoint-durability-consistency",
  bundleName: "checkpoint-skew-probe",
  gameIdPrefix: "checkpoint-durability",
  durationMs: 120_000,
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
      body: { type: "commit", marker: "committed" },
    },
    {
      type: "expect-history-events",
      events: ["state.flush"],
      minimumPerGame: 1,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 1,
      intervalMs: 0,
      body: { type: "dirty", marker: "interval" },
    },
    {
      type: "wait",
      durationMs: 1_500,
    },
    {
      type: "await-nemesis",
      action: "crash-runner",
      minimumOccurrences: 1,
    },
    {
      type: "wait",
      durationMs: 750,
    },
    {
      type: "close-sessions",
      reason: "firstCrashObserved",
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
      body: { type: "probe", marker: "after-interval-crash" },
    },
    {
      type: "wait",
      durationMs: 100,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 1,
      intervalMs: 0,
      body: { type: "dirty", marker: "volatile" },
    },
    {
      type: "wait",
      durationMs: 100,
    },
    {
      type: "await-nemesis",
      action: "crash-runner",
      minimumOccurrences: 2,
    },
    {
      type: "wait",
      durationMs: 750,
    },
    {
      type: "close-sessions",
      reason: "secondCrashObserved",
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
      body: { type: "probe", marker: "after-unplanned-crash" },
    },
    {
      type: "wait",
      durationMs: 100,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 1,
      intervalMs: 0,
      body: { type: "dirty", marker: "planned" },
    },
    {
      type: "wait",
      durationMs: 100,
    },
    {
      type: "evict-games",
      targetGameCount: 1,
      reason: "plannedCheckpointTransition",
    },
    {
      type: "wait",
      durationMs: 500,
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
      body: { type: "probe", marker: "after-planned-evict" },
    },
    {
      type: "wait",
      durationMs: 100,
    },
    {
      type: "close-sessions",
      reason: "scenarioComplete",
    },
    {
      type: "expect-history-events",
      events: ["state.write", "blob.put", "state.checkpoint", "state.flush.plannedTransition"],
      minimumPerGame: 1,
    },
  ],
} satisfies ScenarioWorkloadPlan;
