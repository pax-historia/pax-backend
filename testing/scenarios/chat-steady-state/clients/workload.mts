import type { ScenarioWorkloadPlan } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "chat-steady-state",
  bundleName: "hello-ws-echo",
  gameIdPrefix: "chat-steady",
  durationMs: 300_000,
  maxGames: 64,
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
      sessionsPerGame: 4,
      rampMs: 30_000,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 120,
      intervalMs: 1_000,
      body: { type: "chat", text: "steady-state" },
    },
    {
      type: "close-sessions",
      reason: "scenarioComplete",
    },
    {
      type: "expect-history-events",
      events: ["session.opened", "onPlayerMessage", "ws.send", "session.closed"],
      minimumPerGame: 1,
    },
  ],
} satisfies ScenarioWorkloadPlan;
