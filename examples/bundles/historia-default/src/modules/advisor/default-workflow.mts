export const DEFAULT_ADVISOR_WORKFLOW = `
function* onAdvisorMessage(input) {
  const ai = yield {
    type: "callAI",
    promptStage: "advisor",
    prompt: String(input.body.question ?? input.body.content ?? ""),
    splitPlayerIDs: [input.playerId]
  };
  return { advice: ai && ai.text ? ai.text : "Consider the long-term consequences." };
}
`;
