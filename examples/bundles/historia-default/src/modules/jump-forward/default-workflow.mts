export const DEFAULT_JUMP_FORWARD_WORKFLOW = `
function* onJumpForward(input) {
  const ai = yield {
    type: "callAI",
    promptStage: "jump-forward",
    prompt: String(input.body.prompt ?? "advance the world one round"),
    splitPlayerIDs: [input.playerId],
    stream: true
  };
  const flags = yield {
    type: "fetchFlag",
    query: String(input.body.flagQuery ?? "new country"),
    limit: 2
  };
  return { summary: ai && ai.text ? ai.text : "The world advances.", flags };
}
`;
