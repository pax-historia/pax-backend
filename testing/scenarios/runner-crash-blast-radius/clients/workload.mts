import type { ScenarioWorkloadPlan } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "runner-crash-blast-radius",
  bundleName: "hello-state-rw",
  gameIdPrefix: "runner-crash",
  durationMs: 120_000,
  maxGames: 2,
  fixtures: [
    { kind: "allowed-players", path: "fixtures/allowed-players.json" },
    { kind: "initial-state", path: "fixtures/initial-state.json" },
  ],
  phases: [
    {
      type: "seed-fixtures",
      fixtureKinds: ["allowed-players", "initial-state"],
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
      body: { type: "state-marker", marker: "before-runner-crash" },
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
      reason: "runnerCrashObserved",
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
      body: { type: "state-marker", marker: "after-runner-crash" },
    },
    {
      type: "close-sessions",
      reason: "scenarioComplete",
    },
    {
      type: "expect-history-events",
      events: ["session.opened", "onPlayerMessage", "state.write", "state.flush"],
      minimumPerGame: 2,
    },
  ],
} satisfies ScenarioWorkloadPlan;
