import { makeWorkload } from "../../_shared/scenario.mjs";

export default makeWorkload({
  scenarioId: "spectator-billing-block",
  gameIdPrefix: "historia-spectator-block",
  body: { type: "chat.send", content: "I should not be billed." },
});
