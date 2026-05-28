import { makeWorkload, participant } from "../../_shared/scenario.mjs";

export default makeWorkload({
  scenarioId: "moderation-flow",
  gameIdPrefix: "historia-moderation",
  preMessageHostEvents: [participant("player-1", "entity-1")],
  body: { type: "chat.send", content: "please flag this message" },
});
