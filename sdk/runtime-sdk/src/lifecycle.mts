import type {
  OnCapacityWarningPayload,
  OnHostEventPayload,
  OnPlayerConnectPayload,
  OnPlayerDisconnectPayload,
  OnPlayerMessagePayload,
  OnSleepPayload,
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
}
