import type { SubstrateContext } from "@pax-backend/runtime-sdk";

import type { HistoriaGameContext } from "../context.mjs";

export interface PlayerMessageInput {
  readonly c: SubstrateContext;
  readonly ctx: HistoriaGameContext;
  readonly playerId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly jwtClaims: Readonly<Record<string, unknown>>;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface HostEventInput {
  readonly c: SubstrateContext;
  readonly ctx: HistoriaGameContext;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: unknown;
}

export type PlayerMessageHandler = (input: PlayerMessageInput) => Promise<boolean>;
export type HostEventHandler = (input: HostEventInput) => Promise<boolean>;
