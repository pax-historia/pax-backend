import type {
  BrokerToRunnerEnvelope,
  RunnerAssignment,
  RunnerInvoke,
  RunnerKind,
  RunnerTelemetry,
} from "@pax-backend/ipc-protocol";

export type {
  BrokerToRunnerEnvelope,
  RunnerAssignment,
  RunnerInvoke,
  RunnerKind,
  RunnerTelemetry,
} from "@pax-backend/ipc-protocol";

export interface BrokerBridge {
  request(gameId: string, channel: string, payload: unknown): Promise<unknown>;
  emit(gameId: string, channel: string, payload: unknown): void | Promise<void>;
  emitTelemetry(telemetry: RunnerTelemetry): void;
}

export interface RunnerProcess {
  readonly id: string;
  readonly kind: RunnerKind;
  readonly assignedGames: ReadonlySet<string>;
  readonly maxAssignedGames?: number;
  assign(input: RunnerAssignment): Promise<void>;
  send(envelope: BrokerToRunnerEnvelope): Promise<void>;
  invoke(input: RunnerInvoke): Promise<unknown>;
  release(gameId: string): Promise<void>;
  stop(): Promise<void>;
  crashForTest?(): boolean;
}

export class RunnerPool {
  private readonly runners: RunnerProcess[];
  private readonly assignments = new Map<string, RunnerProcess>();

  constructor(runners: readonly RunnerProcess[]) {
    if (runners.length === 0) throw new Error("RunnerPool requires at least one runner");
    this.runners = [...runners];
  }

  async assign(input: RunnerAssignment): Promise<RunnerProcess> {
    const runner = this.pickRunner();
    await runner.assign(input);
    this.assignments.set(input.gameId, runner);
    return runner;
  }

  async invoke(input: RunnerInvoke): Promise<unknown> {
    const runner = this.assignments.get(input.gameId);
    if (!runner) throw new Error(`game ${input.gameId} is not assigned to a runner`);
    return runner.invoke(input);
  }

  async release(gameId: string): Promise<void> {
    const runner = this.assignments.get(gameId);
    if (!runner) return;
    await runner.release(gameId);
    this.assignments.delete(gameId);
  }

  async stop(): Promise<void> {
    await Promise.all(this.runners.map((runner) => runner.stop()));
    this.assignments.clear();
  }

  crashRunnerForTest(runnerId: string): boolean {
    const runner = this.runners.find((candidate) => candidate.id === runnerId);
    return runner?.crashForTest?.() ?? false;
  }

  replaceRunner(runnerId: string, replacement: RunnerProcess): void {
    const index = this.runners.findIndex((runner) => runner.id === runnerId);
    if (index < 0) throw new Error(`runner ${runnerId} is not in the pool`);
    this.runners[index] = replacement;
    for (const [gameId, runner] of [...this.assignments]) {
      if (runner.id === runnerId) this.assignments.delete(gameId);
    }
  }

  private pickRunner(): RunnerProcess {
    const available = this.runners.filter(
      (runner) =>
        runner.maxAssignedGames === undefined ||
        runner.assignedGames.size < runner.maxAssignedGames,
    );
    if (available.length === 0) throw new Error("no Runner has assignment capacity");
    return [...available].sort((left, right) => left.assignedGames.size - right.assignedGames.size)[0]!;
  }
}

export * from "./noivm.mjs";
export * from "./ivm.mjs";
export * from "./child-process.mjs";
