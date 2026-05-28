import type {
  ConnectedSessionSnapshot,
  MetricsEmitPayload,
  WsSendResponse,
  WsTarget,
} from "@pax-backend/ipc-protocol";

import type { ComputeBudgetChannel } from "./compute-budgets.mjs";
import type { ExternalApiChannel } from "./external-api-channel.mjs";
import type { BlobStorageChannel, StateStorageChannel } from "./storage.mjs";

export type {
  ConnectedSessionSnapshot,
  MetricsEmitPayload,
  WsSendResponse,
  WsTarget,
} from "@pax-backend/ipc-protocol";

export interface WebSocketChannel {
  /**
   * Send a JSON-safe body to one or more players on this game. Use the
   * literal `"all"` to broadcast to every connected player.
   */
  send(target: WsTarget, body: unknown): Promise<WsSendResponse>;
}

export interface LogChannel {
  /** Structured log; routed to history with bundle metadata attached. */
  emit(payload: Readonly<Record<string, unknown>>): void;
}

export interface MetricsChannel {
  /** Numeric metric; counter, gauge, or histogram. */
  emit(payload: MetricsEmitPayload): void;
}

export interface LifecycleChannel {
  /** Voluntary shutdown signal. The substrate may sleep this game soon. */
  requestSleep(): void;
}

export interface PlayersChannel {
  /** Read the substrate-owned per-game whitelist. */
  allowed(): Promise<readonly string[]>;
  /** Read currently connected sessions for this game. */
  connected(): Promise<readonly ConnectedSessionSnapshot[]>;
}

export interface SubstrateContext {
  /** Deterministic substrate PRNG for test-mode repeatability; returns [0, 1). */
  rng(): number;
  /** Deterministic substrate monotonic clock for creator code. */
  now(): number;
  readonly ws: WebSocketChannel;
  readonly log: LogChannel;
  readonly metrics: MetricsChannel;
  readonly lifecycle: LifecycleChannel;
  readonly api: ExternalApiChannel;
  readonly players: PlayersChannel;
  readonly compute: ComputeBudgetChannel;
  readonly state: StateStorageChannel;
  readonly blob: BlobStorageChannel;
}
