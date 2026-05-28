export interface WorkflowTask {
  readonly taskId: string;
  readonly entryPoint: string;
  readonly startedAt: number;
}

export class WorkflowTaskTracker {
  readonly #tasks = new Map<string, WorkflowTask>();
  #nextTaskId = 1;

  start(entryPoint: string, now: number): WorkflowTask {
    const task: WorkflowTask = {
      taskId: `workflow:${this.#nextTaskId}`,
      entryPoint,
      startedAt: now,
    };
    this.#nextTaskId += 1;
    this.#tasks.set(task.taskId, task);
    return task;
  }

  finish(taskId: string): void {
    this.#tasks.delete(taskId);
  }

  snapshot(): readonly WorkflowTask[] {
    return [...this.#tasks.values()];
  }
}

export const workflowTaskTracker = new WorkflowTaskTracker();
