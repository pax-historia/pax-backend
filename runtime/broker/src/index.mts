import type { RunnerPool } from "@pax-backend/runner";
import type { StateStore } from "@pax-backend/state-store";

export interface BrokerConfig {
  readonly shardId: string;
  readonly publicUrl: string;
  readonly runtimeContractsSupported: readonly [number, number];
  readonly capacity: {
    readonly maxActiveGames: number;
    readonly softWatermarkPct: number;
    readonly hardWatermarkPct: number;
  };
}

export interface BrokerDependencies {
  readonly runners: RunnerPool;
  readonly stateStore: StateStore;
  readonly history: {
    write(event: Record<string, unknown>): Promise<void>;
  };
  readonly directory: {
    publishCapacity(row: BrokerCapacityRow): Promise<void>;
    removeShard(shardId: string): Promise<void>;
  };
}

export interface BrokerCapacityRow {
  readonly shardId: string;
  readonly url: string;
  readonly healthy: boolean;
  readonly acceptingWakes: boolean;
  readonly runtimeContractsSupported: readonly [number, number];
  readonly activeGames: number;
  readonly lastSeenAt: number;
}

export class Broker {
  private started = false;
  private activeGames = new Set<string>();
  private acceptingWakes = true;

  constructor(
    private readonly config: BrokerConfig,
    private readonly deps: BrokerDependencies,
  ) {}

  async start(): Promise<void> {
    this.started = true;
    await this.publishCapacity();
  }

  async stop(): Promise<void> {
    this.acceptingWakes = false;
    await this.publishCapacity();
    await this.deps.runners.stop();
    await this.deps.directory.removeShard(this.config.shardId);
    this.started = false;
  }

  async wakeGame(input: {
    readonly gameId: string;
    readonly bundleName: string;
    readonly bundleSource: string;
    readonly bundleCompatTag: string;
    readonly runtimeContractRequired: number;
    readonly runId?: string | null;
    readonly memoryLimitMb?: number;
    readonly handlerTimeoutMs?: number;
    readonly testSeed?: number | string;
  }): Promise<void> {
    this.ensureStarted();
    await this.deps.stateStore.openSession({ gameId: input.gameId });
    await this.deps.runners.assign({
      gameId: input.gameId,
      bundleName: input.bundleName,
      bundleSource: input.bundleSource,
      bundleCompatTag: input.bundleCompatTag,
      runtimeContractRequired: input.runtimeContractRequired,
      runId: input.runId ?? null,
      memoryLimitMb: input.memoryLimitMb ?? 256,
      handlerTimeoutMs: input.handlerTimeoutMs ?? 1_000,
      testSeed: input.testSeed,
    });
    this.activeGames.add(input.gameId);
    await this.deps.history.write({
      event: "game.created",
      gameId: input.gameId,
      shardId: this.config.shardId,
      ts: new Date().toISOString(),
    });
    await this.publishCapacity();
  }

  snapshotCapacity(): BrokerCapacityRow {
    const activeGames = this.activeGames.size;
    const hardLimit = Math.floor(this.config.capacity.maxActiveGames * this.config.capacity.hardWatermarkPct);
    return {
      shardId: this.config.shardId,
      url: this.config.publicUrl,
      healthy: this.started,
      acceptingWakes: this.acceptingWakes && activeGames < hardLimit,
      runtimeContractsSupported: this.config.runtimeContractsSupported,
      activeGames,
      lastSeenAt: Date.now(),
    };
  }

  private async publishCapacity(): Promise<void> {
    await this.deps.directory.publishCapacity(this.snapshotCapacity());
  }

  private ensureStarted(): void {
    if (!this.started) throw new Error("broker is not started");
  }
}
