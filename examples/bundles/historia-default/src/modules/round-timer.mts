export interface RoundTimerSnapshot {
  readonly round: number;
  readonly startedAt: number;
  readonly deadlineAt?: number;
}

export function roundTimerSnapshot(round: number, now: number, durationMs?: number): RoundTimerSnapshot {
  return {
    round,
    startedAt: now,
    deadlineAt: durationMs === undefined ? undefined : now + durationMs,
  };
}
