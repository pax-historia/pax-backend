export type OracleStatus = "pass" | "fail" | "inconclusive";

export interface HistoryEvent {
  readonly event: string;
  readonly ts?: string;
  readonly shardId?: string;
  readonly placedShardId?: string;
  readonly pax_seq?: number;
  readonly actorId?: string;
  readonly gameId?: string;
  readonly sessionId?: string;
  readonly playerId?: string;
  readonly runId?: string;
  readonly traceId?: string | null;
  readonly requestId?: string;
  readonly [key: string]: unknown;
}

export interface OracleFinding {
  readonly code: string;
  readonly message: string;
  readonly event?: HistoryEvent;
  readonly detail?: unknown;
}

export interface OracleResult {
  readonly oracle: string;
  readonly guarantee: number;
  readonly status: OracleStatus;
  readonly checkedEvents: number;
  readonly findings: readonly OracleFinding[];
}

export type Oracle = (history: readonly HistoryEvent[]) => OracleResult;
