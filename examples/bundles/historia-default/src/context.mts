import type {
  ApiInvokeResponse,
  StorageWriteResponse,
  SubstrateContext,
} from "@pax-backend/runtime-sdk";

import { decodeCbor, encodeCbor } from "./core/codec.mjs";
import { withGamePatch, withPlayerRecord, withWorkingEvent } from "./core/mutations.mjs";
import type { LoadedHistoriaState } from "./core/persistence.mjs";
import type { HistoriaGameStatus, HistoriaPlayerRecord } from "./core/schema.mjs";

export interface HistoriaGameContext {
  readonly loaded: LoadedHistoriaState;
  now(): number;
  updateLoaded(updater: (loaded: LoadedHistoriaState) => LoadedHistoriaState): LoadedHistoriaState;
  appendWorkingEvent(type: string, payload: unknown): LoadedHistoriaState;
  setPlayerRecord(player: HistoriaPlayerRecord): LoadedHistoriaState;
  patchGame(patch: {
    readonly status?: HistoriaGameStatus;
    readonly title?: string;
    readonly currentRound?: number;
  }): LoadedHistoriaState;
  s3Put(key: string, value: unknown): Promise<StorageWriteResponse>;
  s3Get<T = unknown>(key: string): Promise<T | undefined>;
  apiInvoke(
    kind: string,
    args: unknown,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ApiInvokeResponse>;
  projectionSync(args: Readonly<Record<string, unknown>>): Promise<ApiInvokeResponse>;
}

export function createGameContext(
  c: SubstrateContext,
  getLoaded: () => LoadedHistoriaState,
  setLoaded: (loaded: LoadedHistoriaState) => void,
): HistoriaGameContext {
  return {
    get loaded() {
      return getLoaded();
    },
    now: () => c.now(),
    updateLoaded(updater) {
      const next = updater(getLoaded());
      setLoaded(next);
      return next;
    },
    appendWorkingEvent(type, payload) {
      return this.updateLoaded((loaded) => withWorkingEvent(loaded, type, payload, c.now()));
    },
    setPlayerRecord(player) {
      return this.updateLoaded((loaded) => withPlayerRecord(loaded, player, c.now()));
    },
    patchGame(patch) {
      return this.updateLoaded((loaded) => withGamePatch(loaded, patch, c.now()));
    },
    s3Put: async (key, value) => c.blob.put(blobKey(key), encodeCbor(value)),
    async s3Get<T = unknown>(key: string): Promise<T | undefined> {
      return decodeCbor(await c.blob.get(blobKey(key))) as T | undefined;
    },
    apiInvoke: (kind, args, options) => c.api.invoke(kind, args, options),
    projectionSync: (args) => c.api.invoke("projection.sync.v1", args),
  };
}

function blobKey(key: string): string {
  return key.replace(/^\/+/, "");
}
