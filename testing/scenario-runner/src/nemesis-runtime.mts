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

interface KillShardRuntime {
  readonly action: Extract<NemesisAction, { readonly type: "kill-shard" }>;
  readonly actionIndex: number;
  timer?: NodeJS.Timeout;
  occurrences: number;
}

export class NemesisRuntime {
  readonly #killShardRuntimes: KillShardRuntime[];
  readonly #killedAtByShard = new Map<string, number>();
  readonly #replacementTimersByShard = new Map<string, NodeJS.Timeout>();
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
  }

  start(): void {
    for (const runtime of this.#killShardRuntimes) {
      this.#scheduleKillShard(runtime);
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    for (const runtime of this.#killShardRuntimes) {
      if (runtime.timer) clearTimeout(runtime.timer);
    }
    for (const timer of this.#replacementTimersByShard.values()) {
      clearTimeout(timer);
    }
    this.#replacementTimersByShard.clear();
  }

  throwIfFailed(): void {
    if (this.#failure) throw this.#failure;
  }

  async waitFor(
    action: "kill-shard",
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
      shardId: shard.shardId,
      selection: runtime.action.selection,
      replacement: runtime.action.replacement,
      adminAction: "POST /admin/shards/:id/drain",
    });
    if (runtime.action.replacement === "let-orchestrator-replace") {
      this.#scheduleReplacementReady(runtime, shard.shardId);
    }
  }

  #scheduleReplacementReady(runtime: KillShardRuntime, shardId: string): void {
    const existing = this.#replacementTimersByShard.get(shardId);
    if (existing) return;
    const timer = setTimeout(() => {
      this.#replacementTimersByShard.delete(shardId);
      void this.#markReplacementReady(runtime, shardId).catch((err: unknown) => {
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
    this.#replacementTimersByShard.set(shardId, timer);
  }

  async #markReplacementReady(runtime: KillShardRuntime, shardId: string): Promise<void> {
    if (this.#stopped) return;
    await requestJson(
      `${this.controlPlaneUrl}/admin/shards/${encodeURIComponent(shardId)}/drain`,
      { method: "DELETE" },
    );
    this.historyWriter.append("nemesis.kill-shard.replacement-ready", {
      nemesisId: this.manifest.nemesisId,
      runId: this.runId ?? null,
      actionIndex: runtime.actionIndex,
      occurrence: runtime.occurrences,
      shardId,
      replacement: runtime.action.replacement,
      delayMs: this.#replacementReadyDelayMs,
      adminAction: "DELETE /admin/shards/:id/drain",
    });
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

  #occurrences(action: "kill-shard"): number {
    if (action !== "kill-shard") return 0;
    return this.#killShardRuntimes.reduce((sum, runtime) => sum + runtime.occurrences, 0);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)));
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
