import type { ScenarioWorkloadPlan } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "race-and-deploy-adversarial",
  bundleName: "race-edge-probe-v1",
  gameIdPrefix: "race-deploy",
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
      body: { type: "marker", label: "before-flip" },
    },
    {
      type: "flip-bundles",
      newBundleName: "race-edge-probe-v2",
      targetGameCount: 1,
    },
    {
      type: "send-json",
      channel: "websocket",
      messagesPerSession: 1,
      intervalMs: 0,
      body: { type: "request-sleep", label: "sleep-after-active-flip" },
    },
    {
      type: "close-sessions",
      reason: "raceSleep",
    },
    {
      type: "send-host-events",
      eventType: "race.afterRequest",
      payload: { marker: "during-requested-sleep" },
      wakeOnDelivery: true,
      targetGameCount: 1,
    },
    {
      type: "expect-history-events",
      events: [
        "bundle.flip.succeeded",
        "lifecycle.requestSleep",
        "onSleep.sent",
        "lifecycle.sleepComplete",
        "onHostEvent.received",
      ],
      minimumPerGame: 1,
    },
    {
      type: "send-host-events",
      eventType: "race.afterSleep",
      payload: { marker: "wake-upgraded-bundle" },
      wakeOnDelivery: true,
      targetGameCount: 1,
    },
    {
      type: "expect-history-events",
      events: ["onWake.sent", "onHostEvent.delivered", "log.emit"],
      minimumPerGame: 1,
    },
    {
      type: "open-sessions",
      playerSource: "allowed-players",
      sessionsPerGame: 2,
      rampMs: 0,
    },
    {
      type: "sleep-wake",
      cycles: 2,
      idleMsBetweenCycles: 0,
    },
    {
      type: "close-sessions",
      reason: "scenarioComplete",
    },
    {
      type: "expect-history-events",
      events: ["session.opened", "session.closed", "state.write", "blob.put"],
      minimumPerGame: 1,
    },
  ],
} satisfies ScenarioWorkloadPlan;
