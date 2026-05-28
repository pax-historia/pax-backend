import { handleActionsMessage } from "../modules/actions/actions.mjs";
import { handleAdminMessage } from "../modules/admin/admin.mjs";
import { handleAdvisorMessage } from "../modules/advisor/advisor.mjs";
import { handleChatMessage } from "../modules/chat/chat.mjs";
import { handleCheatsMessage } from "../modules/cheats/cheats.mjs";
import { handleJumpForwardMessage } from "../modules/jump-forward/jump-forward.mjs";
import { maybeModerateMessage } from "../modules/moderation/moderation.mjs";
import type { PlayerMessageInput } from "../modules/types.mjs";

const handlers = [
  handleAdminMessage,
  handleCheatsMessage,
  handleAdvisorMessage,
  handleActionsMessage,
  handleJumpForwardMessage,
  handleChatMessage,
] as const;

export async function dispatchPlayerMessage(input: PlayerMessageInput): Promise<boolean> {
  await maybeModerateMessage(input);
  for (const handler of handlers) {
    if (await handler(input)) return true;
  }
  return false;
}
