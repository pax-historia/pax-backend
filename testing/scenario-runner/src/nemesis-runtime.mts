import { performance } from "node:perf_hooks";

import type { HistoryWriter } from "./driver-history.mjs";
import type { NemesisAction, NemesisManifest } from "./types.mjs";

interface ShardRecord {
  readonly shardId: string;
  readonly acceptingWakes?: boolean;
  readonly healthy?: boolean;
}

interface ShardsResponse {
  readonly shards?: readonly ShardRecord[];
}

interface ApiKindRegistration {
  readonly kindName: string;
  readonly url: string;
  readonly registeredAt?: number;
}

interface ApiKindResourceResponse {
  readonly registration?: ApiKindRegistration;
}

interface KillShardRuntime {
  readonly action: Extract<NemesisAction, { readonly type: "kill-shard" }>;
  readonly actionIndex: number;
  timer?: NodeJS.Timeout;
  occurrences: number;
}

interface ApiKindPartitionRuntime {
  readonly action: Extract<NemesisAction, { readonly type: "api-kind-partition" }>;
  readonly actionIndex: number;
  timer?: NodeJS.Timeout;
  occurrences: number;
}

interface ReplacementReadyTimer {
  readonly runtime: KillShardRuntime;
  readonly shardId: string;
  readonly occurrence: number;
  readonly timer: NodeJS.Timeout;
}

interface ApiKindPartitionRestoreTimer {
  readonly runtime: ApiKindPartitionRuntime;
  readonly kindName: string;
  readonly occurrence: number;
  readonly previousRegistration: ApiKindRegistration | undefined;
  readonly timer: NodeJS.Timeout;
}

type AwaitableNemesisAction = "kill-shard" | "api-kind-partition";

export class NemesisRuntime {
  readonly #killShardRuntimes: KillShardRuntime[];
  readonly #apiKindPartitionRuntimes: ApiKindPartitionRuntime[];
  readonly #killedAtByShard = new Map<string, number>();
  readonly #replacementTimersByShard = new Map<string, ReplacementReadyTimer>();
  readonly #apiKindPartitionTimersByKind = new Map<string, ApiKindPartitionRestoreTimer>();
  readonly #replacementReadyDelayMs = positiveInt(
    process.env["PAX_NEMESIS_REPLACEMENT_READY_MS"],
    60_000,
  );
  #roundRobinCursor = 0;
  #stopped = false;
  #failure: Error | undefined;

  constructor(
    readonly manifest: NemesisManifest,
    readonly controlPlaneUrl: string,
    readonly historyWriter: HistoryWriter,
    readonly runId: string | undefined,
  ) {
    this.#killShardRuntimes = manifest.actions.flatMap((action, actionIndex) =>
      action.type === "kill-shard"
        ? [{ action, actionIndex, occurrences: 0 } satisfies KillShardRuntime]
        : [],
    );
    this.#apiKindPartitionRuntimes = manifest.actions.flatMap((action, actionIndex) =>
      action.type === "api-kind-partition"
        ? [{ action, actionIndex, occurrences: 0 } satisfies ApiKindPartitionRuntime]
        : [],
    );
  }

  start(): void {
    for (const runtime of this.#killShardRuntimes) {
      this.#scheduleKillShard(runtime);
    }
    for (const runtime of this.#apiKindPartitionRuntimes) {
      this.#scheduleApiKindPartition(runtime);
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const runtime of this.#killShardRuntimes) {
      if (runtime.timer) clearTimeout(runtime.timer);
    }
    for (const runtime of this.#apiKindPartitionRuntimes) {
      if (runtime.timer) clearTimeout(runtime.timer);
    }
    const pendingReplacements = Array.from(this.#replacementTimersByShard.values());
    for (const replacement of pendingReplacements) {
      clearTimeout(replacement.timer);
    }
    this.#replacementTimersByShard.clear();
    const pendingApiKindPartitions = Array.from(this.#apiKindPartitionTimersByKind.values());
    for (const partition of pendingApiKindPartitions) {
      clearTimeout(partition.timer);
    }
    this.#apiKindPartitionTimersByKind.clear();
    await Promise.all(
      [
        ...pendingReplacements.map((replacement) =>
          this.#markReplacementReady(
            replacement.runtime,
            replacement.shardId,
            replacement.occurrence,
            true,
          ).catch((err: unknown) => {
            this.historyWriter.append("nemesis.action.failed", {
              nemesisId: this.manifest.nemesisId,
              runId: this.runId ?? null,
              actionType: replacement.runtime.action.type,
              actionIndex: replacement.runtime.actionIndex,
              error: err instanceof Error ? err.message : String(err),
            });
          }),
        ),
        ...pendingApiKindPartitions.map((partition) =>
          this.#restoreApiKindPartition(
            partition.runtime,
            partition.kindName,
            partition.occurrence,
            partition.previousRegistration,
            true,
          ).catch((err: unknown) => {
            this.historyWriter.append("nemesis.action.failed", {
              nemesisId: this.manifest.nemesisId,
              runId: this.runId ?? null,
              actionType: partition.runtime.action.type,
              actionIndex: partition.runtime.actionIndex,
              error: err instanceof Error ? err.message : String(err),
            });
          }),
        ),
      ],
    );
  }

  throwIfFailed(): void {
    if (this.#failure) throw this.#failure;
  }

  async waitFor(
    action: AwaitableNemesisAction,
    minimumOccurrences: number,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() <= deadline) {
      this.throwIfFailed();
      const count = this.#occurrences(action);
      if (count >= minimumOccurrences) return;
      await sleep(250);
    }
    throw new Error(
      `timed out waiting for nemesis ${action}: wanted ${minimumOccurrences}, observed ${this.#occurrences(
        action,
      )}`,
    );
  }

  #scheduleKillShard(runtime: KillShardRuntime): void {
    if (this.#stopped) return;
    runtime.timer = setTimeout(() => {
      void this.#injectKillShard(runtime)
        .catch((err: unknown) => {
          this.#failure = err instanceof Error ? err : new Error(String(err));
          this.historyWriter.append("nemesis.action.failed", {
            nemesisId: this.manifest.nemesisId,
            runId: this.runId ?? null,
            actionType: runtime.action.type,
            actionIndex: runtime.actionIndex,
            error: this.#failure.message,
          });
        })
        .finally(() => {
          this.#scheduleKillShard(runtime);
        });
    }, runtime.action.everyMs);
  }

  #scheduleApiKindPartition(runtime: ApiKindPartitionRuntime): void {
    if (this.#stopped) return;
    runtime.timer = setTimeout(() => {
      void this.#injectApiKindPartition(runtime).catch((err: unknown) => {
        this.#failure = err instanceof Error ? err : new Error(String(err));
        this.historyWriter.append("nemesis.action.failed", {
          nemesisId: this.manifest.nemesisId,
          runId: this.runId ?? null,
          actionType: runtime.action.type,
          actionIndex: runtime.actionIndex,
          error: this.#failure.message,
        });
      });
    }, runtime.action.afterMs);
  }

  async #injectKillShard(runtime: KillShardRuntime): Promise<void> {
    if (this.#stopped) return;
    const shard = await this.#selectShard(runtime.action);
    await requestJson(
      `${this.controlPlaneUrl}/admin/shards/${encodeURIComponent(shard.shardId)}/drain`,
      { method: "POST" },
    );
    runtime.occurrences += 1;
    this.#killedAtByShard.set(shard.shardId, Date.now());
    this.historyWriter.append("nemesis.kill-shard.injected", {
      nemesisId: this.manifest.nemesisId,
      runId: this.runId ?? null,
      actionIndex: runtime.actionIndex,
      occurrence: runtime.occurrences,
      targetShardId: shard.shardId,
      selection: runtime.action.selection,
      replacement: runtime.action.replacement,
      adminAction: "POST /admin/shards/:id/drain",
    });
    if (runtime.action.replacement === "let-orchestrator-replace") {
      this.#scheduleReplacementReady(runtime, shard.shardId);
    }
  }

  async #injectApiKindPartition(runtime: ApiKindPartitionRuntime): Promise<void> {
    if (this.#stopped) return;
    const { kindName, partitionUrl } = runtime.action;
    if (this.#apiKindPartitionTimersByKind.has(kindName)) {
      throw new Error(`api-kind partition already active for ${kindName}`);
    }
    const previousRegistration = await this.#readApiKindRegistration(kindName);
    await requestJson(`${this.controlPlaneUrl}/admin/api-kinds`, {
      method: "POST",
      body: { kindName, url: partitionUrl },
    });
    runtime.occurrences += 1;
    const occurrence = runtime.occurrences;
    this.historyWriter.append("nemesis.api-kind-partition.injected", {
      nemesisId: this.manifest.nemesisId,
      runId: this.runId ?? null,
      actionIndex: runtime.actionIndex,
      occurrence,
      kindName,
      partitionUrl,
      previousUrl: previousRegistration?.url ?? null,
      durationMs: runtime.action.durationMs,
      adminAction: "POST /admin/api-kinds",
    });
    this.#scheduleApiKindPartitionRestore(runtime, kindName, occurrence, previousRegistration);
  }

  #scheduleReplacementReady(runtime: KillShardRuntime, shardId: string): void {
    const existing = this.#replacementTimersByShard.get(shardId);
    if (existing) return;
    const occurrence = runtime.occurrences;
    const timer = setTimeout(() => {
      this.#replacementTimersByShard.delete(shardId);
      void this.#markReplacementReady(runtime, shardId, occurrence).catch((err: unknown) => {
        this.#failure = err instanceof Error ? err : new Error(String(err));
        this.historyWriter.append("nemesis.action.failed", {
          nemesisId: this.manifest.nemesisId,
          runId: this.runId ?? null,
          actionType: runtime.action.type,
          actionIndex: runtime.actionIndex,
          error: this.#failure.message,
        });
      });
    }, this.#replacementReadyDelayMs);
    this.#replacementTimersByShard.set(shardId, {
      runtime,
      shardId,
      occurrence,
      timer,
    });
  }

  #scheduleApiKindPartitionRestore(
    runtime: ApiKindPartitionRuntime,
    kindName: string,
    occurrence: number,
    previousRegistration: ApiKindRegistration | undefined,
  ): void {
    const timer = setTimeout(() => {
      this.#apiKindPartitionTimersByKind.delete(kindName);
      void this.#restoreApiKindPartition(
        runtime,
        kindName,
        occurrence,
        previousRegistration,
      ).catch((err: unknown) => {
        this.#failure = err instanceof Error ? err : new Error(String(err));
        this.historyWriter.append("nemesis.action.failed", {
          nemesisId: this.manifest.nemesisId,
          runId: this.runId ?? null,
          actionType: runtime.action.type,
          actionIndex: runtime.actionIndex,
          error: this.#failure.message,
        });
      });
    }, runtime.action.durationMs);
    this.#apiKindPartitionTimersByKind.set(kindName, {
      runtime,
      kindName,
      occurrence,
      previousRegistration,
      timer,
    });
  }

  async #markReplacementReady(
    runtime: KillShardRuntime,
    shardId: string,
    occurrence: number,
    force = false,
  ): Promise<void> {
    if (this.#stopped && !force) return;
    await requestJson(
      `${this.controlPlaneUrl}/admin/shards/${encodeURIComponent(shardId)}/drain`,
      { method: "DELETE" },
    );
    this.historyWriter.append("nemesis.kill-shard.replacement-ready", {
      nemesisId: this.manifest.nemesisId,
      runId: this.runId ?? null,
      actionIndex: runtime.actionIndex,
      occurrence,
      targetShardId: shardId,
      replacement: runtime.action.replacement,
      delayMs: this.#replacementReadyDelayMs,
      adminAction: "DELETE /admin/shards/:id/drain",
    });
  }

  async #restoreApiKindPartition(
    runtime: ApiKindPartitionRuntime,
    kindName: string,
    occurrence: number,
    previousRegistration: ApiKindRegistration | undefined,
    force = false,
  ): Promise<void> {
    if (this.#stopped && !force) return;
    let adminAction: string;
    if (previousRegistration) {
      await requestJson(`${this.controlPlaneUrl}/admin/api-kinds`, {
        method: "POST",
        body: { kindName, url: previousRegistration.url },
      });
      adminAction = "POST /admin/api-kinds";
    } else {
      await requestJson(
        `${this.controlPlaneUrl}/admin/api-kinds/${encodeURIComponent(kindName)}`,
        { method: "DELETE" },
      );
      adminAction = "DELETE /admin/api-kinds/:kindName";
    }
    this.historyWriter.append("nemesis.api-kind-partition.restored", {
      nemesisId: this.manifest.nemesisId,
      runId: this.runId ?? null,
      actionIndex: runtime.actionIndex,
      occurrence,
      kindName,
      partitionUrl: runtime.action.partitionUrl,
      restoredUrl: previousRegistration?.url ?? null,
      adminAction,
    });
  }

  async #readApiKindRegistration(kindName: string): Promise<ApiKindRegistration | undefined> {
    const result = await fetchJsonMaybe(
      `${this.controlPlaneUrl}/admin/api-kinds/${encodeURIComponent(kindName)}`,
    );
    if (result.status === 404) return undefined;
    if (result.status !== 200) {
      throw new Error(
        `HTTP ${result.status} for API kind ${kindName}: ${JSON.stringify(result.body)}`,
      );
    }
    const body = result.body as ApiKindResourceResponse;
    const registration = body.registration;
    if (
      !registration ||
      registration.kindName !== kindName ||
      typeof registration.url !== "string"
    ) {
      throw new Error(`malformed API kind registration response for ${kindName}`);
    }
    return registration;
  }

  async #selectShard(
    action: Extract<NemesisAction, { readonly type: "kill-shard" }>,
  ): Promise<ShardRecord> {
    const response = await requestJson<ShardsResponse>(`${this.controlPlaneUrl}/admin/shards`);
    const shards = (response.shards ?? []).filter(
      (shard) => shard.healthy !== false && shard.acceptingWakes !== false,
    );
    if (shards.length === 0) throw new Error("nemesis kill-shard found no eligible shards");
    const sorted = Array.from(shards).sort((a, b) => a.shardId.localeCompare(b.shardId));
    if (action.selection === "round-robin") {
      const selected = sorted[this.#roundRobinCursor % sorted.length];
      this.#roundRobinCursor += 1;
      if (!selected) throw new Error("round-robin shard selection failed");
      return selected;
    }
    return sorted.reduce((best, shard) => {
      const bestKilledAt = this.#killedAtByShard.get(best.shardId) ?? 0;
      const shardKilledAt = this.#killedAtByShard.get(shard.shardId) ?? 0;
      if (shardKilledAt < bestKilledAt) return shard;
      if (shardKilledAt === bestKilledAt && shard.shardId < best.shardId) return shard;
      return best;
    });
  }

  #occurrences(action: AwaitableNemesisAction): number {
    if (action === "kill-shard") {
      return this.#killShardRuntimes.reduce((sum, runtime) => sum + runtime.occurrences, 0);
    }
    return this.#apiKindPartitionRuntimes.reduce((sum, runtime) => sum + runtime.occurrences, 0);
  }
}

async function requestJson<T = unknown>(
  url: string,
  options: { readonly method?: string; readonly body?: unknown } = {},
): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers:
      options.body === undefined
        ? undefined
        : {
            "content-type": "application/json",
          },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  const body = text.trim().length === 0 ? {} : (JSON.parse(text) as unknown);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

async function fetchJsonMaybe(
  url: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(url);
  const text = await response.text();
  return {
    status: response.status,
    body: text.trim().length === 0 ? {} : (JSON.parse(text) as unknown),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)));
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
