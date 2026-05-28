import type {
  BlobListItem,
  StorageWriteResponse,
} from "@pax-backend/ipc-protocol";

export type {
  BlobListItem,
  StorageWriteResponse,
} from "@pax-backend/ipc-protocol";

export interface StateStorageChannel {
  /** Read the small, fast per-game state tier. */
  read(): Promise<unknown | undefined>;
  /** Replace the small state tier value. Fails with sizeExceeded over 128 KB. */
  write(value: unknown): Promise<StorageWriteResponse>;
  /** Force-flush pending state writes. Redis-backed local mode is already immediate. */
  flush(): Promise<StorageWriteResponse>;
}

export interface BlobStorageChannel {
  /** Put one durable key in the per-game blob namespace. */
  put(key: string, bytes: Uint8Array): Promise<StorageWriteResponse>;
  /** Read one key from the per-game blob namespace. */
  get(key: string): Promise<Uint8Array | null>;
  /** Delete one key from the per-game blob namespace. */
  delete(key: string): Promise<{ readonly ok: true }>;
  /** List keys in the per-game blob namespace. */
  list(prefix?: string): Promise<readonly BlobListItem[]>;
}
