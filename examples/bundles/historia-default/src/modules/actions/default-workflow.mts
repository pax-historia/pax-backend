export const DEFAULT_ACTIONS_WORKFLOW = `
function* onRequestSuggestions(input) {
  const ai = yield {
    type: "callAI",
    promptStage: "actions",
    prompt: String(input.body.prompt ?? "suggest player actions"),
    splitPlayerIDs: [input.playerId]
  };
  return { suggestions: ai && ai.text ? [ai.text] : ["Scout", "Negotiate", "Fortify"] };
}
`;
