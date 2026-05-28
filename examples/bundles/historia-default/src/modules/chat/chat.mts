import { executeWorkflowCommand } from "../../ai/executors.mjs";
import { runWorkflow } from "../../ai/engine.mjs";
import { isParticipant } from "../player-management.mjs";
import type { PlayerMessageHandler } from "../types.mjs";
import { readBodyType, readString } from "../util.mjs";
import { DEFAULT_CHAT_WORKFLOW } from "./default-workflow.mjs";

export const handleChatMessage: PlayerMessageHandler = async (input) => {
  if (readBodyType(input.body) !== "chat.send") return false;
  if (!isParticipant(input.ctx, input.playerId)) {
    input.ctx.appendWorkingEvent("policy.refused", {
      playerId: input.playerId,
      seq: input.seq,
      reason: "playerIsSpectator",
      surface: "chat",
    });
    await input.c.ws.send(input.playerId, {
      type: "historia.policyRefused",
      reason: "playerIsSpectator",
      seq: input.seq,
    });
    return true;
  }
  const workflow = input.ctx.loaded.blob.workflows?.chat;
  const result = await runWorkflow({
    code: workflow?.code ?? DEFAULT_CHAT_WORKFLOW,
    entryPoint: workflow?.entryPoints.onHumanMessage ?? "onHumanMessage",
    input,
    execute: (command) => executeWorkflowCommand(input.ctx, command),
  });
  const text = readWorkflowText(result, "I hear you.");
  input.ctx.appendWorkingEvent("chat.message", {
    playerId: input.playerId,
    seq: input.seq,
    content: readString(input.body["content"]),
  });
  input.ctx.appendWorkingEvent("chat.ai", {
    seq: input.seq,
    text,
  });
  await input.c.ws.send("all", {
    type: "chat.message",
    playerId: input.playerId,
    seq: input.seq,
    content: readString(input.body["content"]),
  });
  await input.c.ws.send("all", {
    type: "chat.ai",
    seq: input.seq,
    text,
  });
  return true;
};

function readWorkflowText(value: unknown, fallback: string): string {
  return value && typeof value === "object" && "text" in value
    ? readString((value as Record<string, unknown>)["text"], fallback)
    : fallback;
}
