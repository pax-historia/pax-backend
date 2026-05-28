import { makeWorkload, participant } from "../../_shared/scenario.mjs";

export default makeWorkload({
  scenarioId: "advisor-basic",
  gameIdPrefix: "historia-advisor-basic",
  preMessageHostEvents: [participant("player-1", "entity-1")],
  body: { type: "advisor.ask", question: "What should I do next?" },
});
