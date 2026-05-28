import type { ScenarioWorkloadPlan } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "compromised-bundle-adversarial",
  bundleName: "hostile-ws-target",
  gameIdPrefix: "compromised-bundle-adversarial",
  durationMs: 30_000,
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
      body: { type: "try-send-missing-target", target: "intruder-player" },
    },
    {
      type: "expect-history-events",
      events: ["session.opened", "ws.send.rejected", "log.emit"],
      minimumPerGame: 1,
    },
    {
      type: "close-sessions",
      reason: "scenarioComplete",
    },
  ],
} satisfies ScenarioWorkloadPlan;
