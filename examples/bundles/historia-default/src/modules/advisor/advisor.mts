import { executeWorkflowCommand } from "../../ai/executors.mjs";
import { runWorkflow } from "../../ai/engine.mjs";
import type { PlayerMessageHandler } from "../types.mjs";
import { readBodyType, readString } from "../util.mjs";
import { DEFAULT_ADVISOR_WORKFLOW } from "./default-workflow.mjs";

export const handleAdvisorMessage: PlayerMessageHandler = async (input) => {
  if (readBodyType(input.body) !== "advisor.ask") return false;
  const workflow = input.ctx.loaded.blob.workflows?.advisor;
  const result = await runWorkflow({
    code: workflow?.code ?? DEFAULT_ADVISOR_WORKFLOW,
    entryPoint: workflow?.entryPoints.onAdvisorMessage ?? "onAdvisorMessage",
    input,
    execute: (command) => executeWorkflowCommand(input.ctx, command),
  });
  const advice = readAdvice(result);
  input.ctx.appendWorkingEvent("advisor.response", {
    playerId: input.playerId,
    seq: input.seq,
    advice,
  });
  await input.c.ws.send(input.playerId, {
    type: "advisor.response",
    seq: input.seq,
    advice,
  });
  return true;
};

function readAdvice(value: unknown): string {
  if (value && typeof value === "object" && "advice" in value) {
    return readString((value as Record<string, unknown>)["advice"], "Consider the long-term consequences.");
  }
  return "Consider the long-term consequences.";
}
