import { executeWorkflowCommand } from "../../ai/executors.mjs";
import { runWorkflow } from "../../ai/engine.mjs";
import { isParticipant } from "../player-management.mjs";
import { nextRound } from "../rounds.mjs";
import type { PlayerMessageHandler } from "../types.mjs";
import { readBodyType, readString } from "../util.mjs";
import { DEFAULT_JUMP_FORWARD_WORKFLOW } from "./default-workflow.mjs";

export const handleJumpForwardMessage: PlayerMessageHandler = async (input) => {
  if (readBodyType(input.body) !== "jumpForward.request") return false;
  if (!isParticipant(input.ctx, input.playerId)) {
    input.ctx.appendWorkingEvent("policy.refused", {
      playerId: input.playerId,
      seq: input.seq,
      reason: "playerIsSpectator",
      surface: "jumpForward",
    });
    await input.c.ws.send(input.playerId, {
      type: "historia.policyRefused",
      reason: "playerIsSpectator",
      seq: input.seq,
    });
    return true;
  }
  const workflow = input.ctx.loaded.blob.workflows?.jumpForward;
  const result = await runWorkflow({
    code: workflow?.code ?? DEFAULT_JUMP_FORWARD_WORKFLOW,
    entryPoint: workflow?.entryPoints.onJumpForward ?? "onJumpForward",
    input,
    execute: (command) => executeWorkflowCommand(input.ctx, command),
  });
  const round = nextRound(input.ctx.loaded.blob.game.currentRound);
  input.ctx.patchGame({
    status: "in-progress",
    currentRound: round,
  });
  input.ctx.appendWorkingEvent("jumpForward.completed", {
    playerId: input.playerId,
    seq: input.seq,
    round,
    summary: readSummary(result),
  });
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
