import type { WorkflowCommand, WorkflowRunRequest } from "./workflow-runtime-shared.mjs";
import { workflowTaskTracker } from "./task-tracker.mjs";

type WorkflowGenerator = Generator<WorkflowCommand, unknown, unknown>;
type WorkflowEntrypoint = (input: unknown) => WorkflowGenerator | unknown;

export async function runWorkflow(request: WorkflowRunRequest): Promise<unknown> {
  const task = workflowTaskTracker.start(request.entryPoint, request.input.ctx.now());
  const entrypoint = compileEntrypoint(request.code, request.entryPoint);
  try {
    const result = entrypoint(request.input);
    if (!isGenerator(result)) return result;

    let yielded = result.next();
    let resumeValue: unknown = undefined;
    while (!yielded.done) {
      resumeValue = await request.execute(yielded.value);
      yielded = result.next(resumeValue);
    }
    return yielded.value;
  } finally {
    workflowTaskTracker.finish(task.taskId);
  }
}

function compileEntrypoint(code: string, entryPoint: string): WorkflowEntrypoint {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entryPoint)) {
    throw new Error(`workflow entrypoint is not an identifier: ${entryPoint}`);
  }
  const factory = new Function(
    `"use strict";\n${code}\nreturn typeof ${entryPoint} === "function" ? ${entryPoint} : undefined;`,
  );
  const entrypoint = factory() as unknown;
  if (typeof entrypoint !== "function") {
    throw new Error(`workflow entrypoint not found: ${entryPoint}`);
  }
  return entrypoint as WorkflowEntrypoint;
}

function isGenerator(value: unknown): value is WorkflowGenerator {
  return !!value && typeof value === "object" && "next" in value;
}
