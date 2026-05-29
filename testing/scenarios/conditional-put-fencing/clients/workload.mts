import type { ScenarioWorkloadPlan } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "conditional-put-fencing",
  bundleName: "checkpoint-skew-probe",
  gameIdPrefix: "conditional-put",
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
      body: { type: "commit", marker: "base" },
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
      body: { type: "dirty", marker: "stale" },
    },
    {
      type: "inject-fence-winner",
      targetGameCount: 1,
      marker: "winner",
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 1,
      intervalMs: 0,
      body: { type: "commit", marker: "stale-after-winner" },
    },
    {
      type: "wait",
      durationMs: 500,
    },
    {
      type: "close-sessions",
      reason: "fenceConflictObserved",
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
      body: { type: "probe", marker: "after-fence-conflict" },
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
      events: ["state.fence.winner", "state.fence.conflict", "game.stoodDown"],
      minimumPerGame: 1,
    },
  ],
} satisfies ScenarioWorkloadPlan;
