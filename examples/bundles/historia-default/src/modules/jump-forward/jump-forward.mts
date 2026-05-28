import { executeWorkflowCommand } from "../../ai/executors.mjs";
import { runWorkflow } from "../../ai/engine.mjs";
import { nextRound } from "../rounds.mjs";
import type { PlayerMessageHandler } from "../types.mjs";
import { readBodyType, readString } from "../util.mjs";
import { DEFAULT_JUMP_FORWARD_WORKFLOW } from "./default-workflow.mjs";

export const handleJumpForwardMessage: PlayerMessageHandler = async (input) => {
  if (readBodyType(input.body) !== "jumpForward.request") return false;
  const workflow = input.ctx.loaded.blob.workflows?.jumpForward;
  const result = await runWorkflow({
    code: workflow?.code ?? DEFAULT_JUMP_FORWARD_WORKFLOW,
    entryPoint: workflow?.entryPoints.onJumpForward ?? "onJumpForward",
    input,
    execute: (command) => executeWorkflowCommand(input.ctx, command),
  });
  const round = nextRound(input.ctx.loaded.blob.game.currentRound);
  await input.ctx.projectionSync({ op: "roundDisplay", displayedRound: round });
  await input.c.ws.send("all", {
    type: "jumpForward.completed",
    seq: input.seq,
    round,
    summary: readSummary(result),
  });
  return true;
};

function readSummary(value: unknown): string {
  if (value && typeof value === "object" && "summary" in value) {
    return readString((value as Record<string, unknown>)["summary"], "The world advances.");
  }
  return "The world advances.";
}
