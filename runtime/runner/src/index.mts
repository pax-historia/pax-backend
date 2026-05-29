export type RunnerKind = "ivm" | "noivm";

export interface RunnerAssignment {
  readonly gameId: string;
  readonly bundleName: string;
  readonly bundleSource: string;
  readonly runtimeContractRequired: number;
  readonly testSeed?: string;
}

export interface RunnerInvoke {
  readonly gameId: string;
  readonly handler: string;
  readonly payload: unknown;
  readonly timeoutMs: number;
}

export interface RunnerTelemetry {
  readonly gameId: string;
  readonly runnerId: string;
  readonly memoryBytes: number;
  readonly cpuMs: number;
  readonly isolateCount: number;
}

export interface BrokerBridge {
  request(gameId: string, channel: string, payload: unknown): Promise<unknown>;
  emitTelemetry(telemetry: RunnerTelemetry): void;
}

export interface RunnerProcess {
  readonly id: string;
  readonly kind: RunnerKind;
  readonly assignedGames: ReadonlySet<string>;
  assign(input: RunnerAssignment): Promise<void>;
  invoke(input: RunnerInvoke): Promise<unknown>;
  release(gameId: string): Promise<void>;
  stop(): Promise<void>;
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

  private pickRunner(): RunnerProcess {
    return [...this.runners].sort((left, right) => left.assignedGames.size - right.assignedGames.size)[0]!;
  }
}
