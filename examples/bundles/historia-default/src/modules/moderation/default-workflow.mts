export const DEFAULT_MODERATION_WORKFLOW = `
function* onChatMessage(input) {
  const text = String(input.body.content ?? "");
  if (text.toLowerCase().includes("ban")) return { verdict: "ban", reason: "matched banned content" };
  if (text.toLowerCase().includes("flag")) return { verdict: "flag", reason: "matched flagged content" };
  return { verdict: "ok", reason: "no issue" };
}
`;
