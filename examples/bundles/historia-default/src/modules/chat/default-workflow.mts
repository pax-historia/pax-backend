export const DEFAULT_CHAT_WORKFLOW = `
function* onHumanMessage(input) {
  const ai = yield {
    type: "callAI",
    promptStage: "chat",
    prompt: String(input.body.content ?? ""),
    splitPlayerIDs: [input.playerId]
  };
  return {
    text: ai && ai.text ? ai.text : "I hear you.",
    transactionUUID: ai && ai.transactionUUID ? ai.transactionUUID : undefined
  };
}
`;
