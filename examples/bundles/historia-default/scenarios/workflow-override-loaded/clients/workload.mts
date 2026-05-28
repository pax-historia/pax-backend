import { makeWorkload, participant } from "../../_shared/scenario.mjs";

export default makeWorkload({
  scenarioId: "workflow-override-loaded",
  gameIdPrefix: "historia-workflow-override",
  preMessageHostEvents: [
    participant("player-1", "entity-1"),
    {
      eventType: "workflowOverride",
      payload: {
        module: "chat",
        code: "function* onHumanMessage() { return { text: 'override response' }; }",
        entryPoints: { onHumanMessage: "onHumanMessage" },
      },
    },
  ],
  body: { type: "chat.send", content: "Use override." },
});
