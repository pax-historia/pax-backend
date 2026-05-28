import { makeWorkload, participant } from "../../_shared/scenario.mjs";

export default makeWorkload({
  scenarioId: "role-destroy-flow",
  gameIdPrefix: "historia-role-destroy",
  preMessageHostEvents: [participant("player-1", "entity-1")],
  body: { type: "cheats.reason", reason: "Dissolve role for scenario coverage." },
});
