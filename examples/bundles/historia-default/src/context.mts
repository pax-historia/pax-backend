import type {
  ApiInvokeResponse,
  StorageWriteResponse,
  SubstrateContext,
} from "@pax-backend/runtime-sdk";

import { decodeCbor, encodeCbor } from "./core/codec.mjs";
import type { LoadedHistoriaState } from "./core/persistence.mjs";

export interface HistoriaGameContext {
  readonly loaded: LoadedHistoriaState;
  now(): number;
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
  loaded: LoadedHistoriaState,
): HistoriaGameContext {
  return {
    loaded,
    now: () => c.now(),
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
