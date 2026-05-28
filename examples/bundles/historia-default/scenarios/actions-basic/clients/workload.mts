import { makeWorkload, participant } from "../../_shared/scenario.mjs";

export default makeWorkload({
  scenarioId: "actions-basic",
  gameIdPrefix: "historia-actions-basic",
  preMessageHostEvents: [participant("player-1", "entity-1")],
  body: { type: "actions.request", prompt: "Suggest actions." },
});
