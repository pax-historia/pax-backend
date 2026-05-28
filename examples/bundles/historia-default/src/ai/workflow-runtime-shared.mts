import type { HistoriaGameContext } from "../context.mjs";

export type WorkflowCommand =
  | {
      readonly type: "callAI";
      readonly promptStage: string;
      readonly prompt: string;
      readonly splitPlayerIDs: readonly string[];
      readonly jsonSchema?: unknown;
      readonly stream?: boolean;
    }
  | {
      readonly type: "fetchFlag";
      readonly query: string;
      readonly limit?: number;
    }
  | {
      readonly type: "projectionSync";
      readonly args: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "moderationAudit";
      readonly args: Readonly<Record<string, unknown>>;
    };

export interface WorkflowInput {
  readonly ctx: HistoriaGameContext;
  readonly playerId: string;
  readonly seq: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface WorkflowRunRequest {
  readonly code: string;
  readonly entryPoint: string;
  readonly input: WorkflowInput;
  readonly execute: (command: WorkflowCommand) => Promise<unknown>;
}
