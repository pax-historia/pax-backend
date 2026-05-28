import type { HistoriaGameContext } from "../context.mjs";
import type { WorkflowCommand } from "./workflow-runtime-shared.mjs";

export async function executeWorkflowCommand(
  ctx: HistoriaGameContext,
  command: WorkflowCommand,
): Promise<unknown> {
  switch (command.type) {
    case "callAI":
      return unwrapApiResult(
        await ctx.apiInvoke("ai.chat.v1", {
          modelUsed: "fixture",
          promptStage: command.promptStage,
          promptTemplate: command.promptStage,
          prompt: command.prompt,
          jsonSchema: command.jsonSchema,
          stream: command.stream,
          splitPlayerIDs: command.splitPlayerIDs,
        }),
      );
    case "fetchFlag":
      return unwrapApiResult(
        await ctx.apiInvoke("flag.search.v1", {
          query: command.query,
          sort: "best_match_retrieval_document",
          minNetLikes: -4,
          statusFilter: "approved",
          incrementUseCount: true,
          limit: command.limit ?? 2,
        }),
      );
    case "projectionSync":
      return unwrapApiResult(await ctx.projectionSync(command.args));
    case "moderationAudit":
      return unwrapApiResult(await ctx.apiInvoke("moderation.audit.v1", command.args));
  }
}

function unwrapApiResult(response: Awaited<ReturnType<HistoriaGameContext["apiInvoke"]>>): unknown {
  return response.ok ? response.result : { ok: false, error: response.error, detail: response.detail };
}
