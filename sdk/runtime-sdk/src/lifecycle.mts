import type {
  OnCapacityWarningPayload,
  OnHostEventPayload,
  OnPlayerConnectPayload,
  OnPlayerDisconnectPayload,
  OnPlayerMessagePayload,
  OnSleepPayload,
  OnTickPayload,
  OnWakePayload,
} from "@pax-backend/ipc-protocol";

import type { SubstrateContext } from "./context.mjs";

export type {
  OnCapacityWarningPayload,
  OnHostEventPayload,
  OnPlayerConnectPayload,
  OnPlayerDisconnectPayload,
  OnPlayerMessagePayload,
  OnSleepPayload,
  OnTickPayload,
  OnWakePayload,
} from "@pax-backend/ipc-protocol";

export type Handler<P> = (c: SubstrateContext, payload: P) => void | Promise<void>;

export interface BundleHandlers {
  onWake?: Handler<OnWakePayload>;
  onSleep?: Handler<OnSleepPayload>;
  onPlayerConnect?: Handler<OnPlayerConnectPayload>;
  onPlayerDisconnect?: Handler<OnPlayerDisconnectPayload>;
  onPlayerMessage?: Handler<OnPlayerMessagePayload>;
  onCapacityWarning?: Handler<OnCapacityWarningPayload>;
  onHostEvent?: Handler<OnHostEventPayload>;
  /**
   * Called repeatedly while the game is awake, after the bundle opts in via
   * `c.lifecycle.requestTick(intervalMs)`. The substrate drives the cadence
   * (real time) and stops ticking when the game sleeps. Use a fixed timestep
   * for any simulation; `c.now()` remains a deterministic monotonic counter.
   */
  onTick?: Handler<OnTickPayload>;
}
