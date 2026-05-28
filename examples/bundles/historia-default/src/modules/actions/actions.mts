import { executeWorkflowCommand } from "../../ai/executors.mjs";
import { runWorkflow } from "../../ai/engine.mjs";
import { isParticipant } from "../player-management.mjs";
import type { PlayerMessageHandler } from "../types.mjs";
import { readBodyType } from "../util.mjs";
import { DEFAULT_ACTIONS_WORKFLOW } from "./default-workflow.mjs";

export const handleActionsMessage: PlayerMessageHandler = async (input) => {
  if (readBodyType(input.body) !== "actions.request") return false;
  if (!isParticipant(input.ctx, input.playerId)) {
    input.ctx.appendWorkingEvent("policy.refused", {
      playerId: input.playerId,
      seq: input.seq,
      reason: "playerIsSpectator",
      surface: "actions",
    });
    await input.c.ws.send(input.playerId, {
      type: "historia.policyRefused",
      reason: "playerIsSpectator",
      seq: input.seq,
    });
    return true;
  }
  const workflow = input.ctx.loaded.blob.workflows?.actions;
  const result = await runWorkflow({
    code: workflow?.code ?? DEFAULT_ACTIONS_WORKFLOW,
    entryPoint: workflow?.entryPoints.onRequestSuggestions ?? "onRequestSuggestions",
    input,
    execute: (command) => executeWorkflowCommand(input.ctx, command),
  });
  const suggestions = readSuggestions(result);
  input.ctx.appendWorkingEvent("actions.suggestions", {
    playerId: input.playerId,
    seq: input.seq,
    suggestions,
  });
  await input.c.ws.send(input.playerId, {
    type: "actions.suggestions",
    seq: input.seq,
    suggestions,
  });
  return true;
};

function readSuggestions(value: unknown): readonly string[] {
  if (!value || typeof value !== "object" || !("suggestions" in value)) {
    return ["Scout", "Negotiate", "Fortify"];
  }
  const suggestions = (value as Record<string, unknown>)["suggestions"];
  return Array.isArray(suggestions)
    ? suggestions.filter((entry): entry is string => typeof entry === "string")
    : ["Scout", "Negotiate", "Fortify"];
}
