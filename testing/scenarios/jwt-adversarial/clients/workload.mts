import type { ScenarioWorkloadPlan } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "jwt-adversarial",
  bundleName: "hello-ws-echo",
  gameIdPrefix: "jwt-adversarial",
  durationMs: 30_000,
  maxGames: 2,
  fixtures: [{ kind: "allowed-players", path: "fixtures/allowed-players.json" }],
  phases: [
    {
      type: "seed-fixtures",
      fixtureKinds: ["allowed-players"],
    },
    {
      type: "expect-ws-refusals",
      attempts: [
        {
          placementGameIndex: 1,
          playerId: "player-1",
          tokenMutation: "tamper-signature",
          expectedCodes: [4401, 1011],
        },
        {
          placementGameIndex: 1,
          playerId: "player-1",
          tokenMutation: "expire-token",
          expectedCodes: [4401, 1011],
        },
        {
          placementGameIndex: 1,
          connectGameIndex: 2,
          playerId: "player-1",
          expectedCodes: [4403, 1011],
        },
      ],
    },
  ],
} satisfies ScenarioWorkloadPlan;
