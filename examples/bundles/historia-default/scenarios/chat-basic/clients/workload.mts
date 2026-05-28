import { makeWorkload, participant } from "../../_shared/scenario.mjs";

export default makeWorkload({
  scenarioId: "chat-basic",
  gameIdPrefix: "historia-chat-basic",
  sessionsPerGame: 2,
  preMessageHostEvents: [participant("player-1", "entity-1"), participant("player-2", "entity-2")],
  body: { type: "chat.send", content: "Hello from the scenario." },
});
