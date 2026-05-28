import type { ScenarioWorkloadPlan } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "compute-stress",
  bundleName: "budget-edge-probe",
  gameIdPrefix: "compute-stress",
  durationMs: 120_000,
  maxGames: 1,
  fixtures: [{ kind: "allowed-players", path: "fixtures/allowed-players.json" }],
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
      body: { type: "ws-rate" },
    },
    {
      type: "expect-history-events",
      events: ["ws.send.rejected"],
      minimumPerGame: 1,
    },
    {
      type: "wait",
      durationMs: 1_200,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 1,
      intervalMs: 0,
      body: { type: "ws-bandwidth" },
    },
    {
      type: "expect-history-events",
      events: ["ws.send.rejected"],
      minimumPerGame: 1,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 1,
      intervalMs: 0,
      body: { type: "state-oversize" },
    },
    {
      type: "expect-history-events",
      events: ["state.write"],
      minimumPerGame: 1,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 1_030,
      intervalMs: 0,
      body: { type: "blob-key" },
    },
    {
      type: "expect-history-events",
      events: ["blob.put.rejected"],
      minimumPerGame: 1,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 65,
      intervalMs: 0,
      body: { type: "api-call" },
    },
    {
      type: "expect-history-events",
      events: ["api.invoke.response"],
      minimumPerGame: 1,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 1,
      intervalMs: 0,
      body: { type: "cpu-spin", durationMs: 1_200 },
    },
    {
      type: "expect-history-events",
      events: ["child.handlerError", "compute.budget.rejected"],
      minimumPerGame: 1,
    },
    {
      type: "close-sessions",
      reason: "scenarioComplete",
    },
    {
      type: "expect-history-events",
      events: [
        "child.handlerError",
        "compute.budget.rejected",
        "api.invoke.request",
        "api.invoke.response",
        "state.write",
        "blob.put.rejected",
        "ws.send.rejected",
        "blob.put",
      ],
      minimumPerGame: 1,
    },
  ],
} satisfies ScenarioWorkloadPlan;
