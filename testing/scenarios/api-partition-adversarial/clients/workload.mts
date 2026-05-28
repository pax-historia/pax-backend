import type { ScenarioWorkloadPlan } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "api-partition-adversarial",
  bundleName: "hello-ai-call",
  gameIdPrefix: "api-partition",
  durationMs: 60_000,
  maxGames: 1,
  fixtures: [{ kind: "allowed-players", path: "fixtures/allowed-players.json" }],
  phases: [
    {
      type: "seed-fixtures",
      fixtureKinds: ["allowed-players"],
    },
    {
      type: "register-api-kinds",
      kinds: [
        {
          kindName: "mock-ai.v1",
          url: "${apiGatewayUrl}/_url-services/mock-ai.v1/invoke",
        },
      ],
    },
    {
      type: "open-sessions",
      playerSource: "allowed-players",
      sessionsPerGame: 1,
      rampMs: 0,
    },
    {
      type: "wait",
      durationMs: 4_000,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 40,
      intervalMs: 200,
      body: { type: "api-partition-probe" },
    },
    {
      type: "await-nemesis",
      action: "api-kind-partition",
      minimumOccurrences: 1,
    },
    {
      type: "expect-history-events",
      events: ["api.invoke.response", "api.invoke.wire"],
      minimumPerGame: 1,
    },
    {
      type: "close-sessions",
      reason: "scenarioComplete",
    },
  ],
} satisfies ScenarioWorkloadPlan;
