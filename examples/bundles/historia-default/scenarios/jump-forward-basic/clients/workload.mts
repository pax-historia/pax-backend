import { makeWorkload, participant } from "../../_shared/scenario.mjs";

export default makeWorkload({
  scenarioId: "jump-forward-basic",
  gameIdPrefix: "historia-jump-forward",
  preMessageHostEvents: [participant("player-1", "entity-1")],
  body: { type: "jumpForward.request", prompt: "Advance the world.", flagQuery: "new country" },
});
