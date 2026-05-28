export interface ApiRateDecision {
  readonly ok: boolean;
  readonly currentUsage: number;
  readonly limit: number;
  readonly windowMs: number;
}

export interface ApiInvocationBudget {
  checkAndRecord(gameId: string, nowMs?: number): ApiRateDecision;
}

export class SlidingWindowApiInvocationBudget implements ApiInvocationBudget {
  readonly #hitsByGameId = new Map<string, number[]>();

  constructor(
    readonly limitPerMinute: number,
    readonly windowMs = 60_000,
  ) {
    if (!Number.isInteger(limitPerMinute) || limitPerMinute < 1) {
      throw new Error("api-invocations-per-min limit must be a positive integer");
    }
  }

  checkAndRecord(gameId: string, nowMs = Date.now()): ApiRateDecision {
    const cutoff = nowMs - this.windowMs;
    const existing = this.#hitsByGameId.get(gameId) ?? [];
    const kept = existing.filter((ts) => ts > cutoff);
    const allowed = kept.length < this.limitPerMinute;
    if (allowed) {
      kept.push(nowMs);
    }
    this.#hitsByGameId.set(gameId, kept);
    return {
      ok: allowed,
      currentUsage: kept.length,
      limit: this.limitPerMinute,
      windowMs: this.windowMs,
    };
  }
}

export function budgetFromEnv(env: NodeJS.ProcessEnv): SlidingWindowApiInvocationBudget {
  const limit = Number.parseInt(env["PAX_API_INVOCATIONS_PER_MIN"] ?? "60", 10);
  return new SlidingWindowApiInvocationBudget(Number.isFinite(limit) ? limit : 60);
}
