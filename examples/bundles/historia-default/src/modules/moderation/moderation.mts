import { executeWorkflowCommand } from "../../ai/executors.mjs";
import { runWorkflow } from "../../ai/engine.mjs";
import type { PlayerMessageInput } from "../types.mjs";
import { readBodyType, readString } from "../util.mjs";
import { DEFAULT_MODERATION_WORKFLOW } from "./default-workflow.mjs";

export async function maybeModerateMessage(input: PlayerMessageInput): Promise<void> {
  if (readBodyType(input.body) !== "chat.send") return;
  const workflow = input.ctx.loaded.blob.workflows?.moderation;
  const result = await runWorkflow({
    code: workflow?.code ?? DEFAULT_MODERATION_WORKFLOW,
    entryPoint: workflow?.entryPoints.onChatMessage ?? "onChatMessage",
    input,
    execute: (command) => executeWorkflowCommand(input.ctx, command),
  });
  const verdict = readVerdict(result);
  if (verdict === "ok") return;
  input.ctx.appendWorkingEvent("moderation.verdict", {
    playerId: input.playerId,
    seq: input.seq,
    verdict,
    reason: readReason(result),
  });
  await input.ctx.apiInvoke("moderation.audit.v1", {
    op: "recordVerdict",
    contentId: `${input.sessionId}:${input.seq}`,
    contentKind: "chat",
    playerId: input.playerId,
    verdict,
    reason: readReason(result),
  });
}

function readVerdict(value: unknown): "ok" | "warn" | "flag" | "ban" {
  if (!value || typeof value !== "object" || !("verdict" in value)) return "ok";
  const verdict = (value as Record<string, unknown>)["verdict"];
  return verdict === "warn" || verdict === "flag" || verdict === "ban" ? verdict : "ok";
}

function readReason(value: unknown): string {
  if (value && typeof value === "object" && "reason" in value) {
    return readString((value as Record<string, unknown>)["reason"], "moderation workflow");
  }
  return "moderation workflow";
}
