import { makeWorkload, participant } from "../../_shared/scenario.mjs";

export default makeWorkload({
  scenarioId: "role-claim-flow",
  gameIdPrefix: "historia-role-claim",
  preMessageHostEvents: [participant("player-1", "entity-1")],
});
