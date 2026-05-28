import type {
  OnWakePayload,
  StorageWriteResponse,
  SubstrateContext,
} from "@pax-backend/runtime-sdk";

import { manifest } from "../../manifest.js";
import { decodeCbor, encodeCbor } from "./codec.mjs";
import { migrateBlobToV5, type MigrationResult } from "./migrations.mjs";
import {
  emptyWorkingState,
  normalizeWorkingState,
  type HistoriaBlobV5,
  type HistoriaWorkingState,
} from "./schema.mjs";

export const CURRENT_BLOB_KEY = "current";

export interface LoadedHistoriaState extends MigrationResult {
  readonly workingState: HistoriaWorkingState;
}

export interface PersistWorkingStateResult {
  readonly stateWrite: StorageWriteResponse;
  readonly stateFlush?: StorageWriteResponse;
}

export interface CommitSnapshotResult extends PersistWorkingStateResult {
  readonly blobWrite: StorageWriteResponse;
}

export async function loadHistoriaState(
  c: SubstrateContext,
  payload: OnWakePayload,
): Promise<LoadedHistoriaState> {
  const now = c.now();
  const workingState = normalizeWorkingState(payload.state, now);
  const rawBlob = await c.blob.get(CURRENT_BLOB_KEY);
  const migrated = migrateBlobToV5(
    decodeCbor(rawBlob),
    payload.blobCompatTag ?? payload.bundleCompatTag ?? manifest.compatTagProduced,
    now,
  );
  return {
    ...migrated,
    workingState,
  };
}

export async function persistWorkingState(
  c: SubstrateContext,
  workingState: HistoriaWorkingState,
  options: { readonly flush?: boolean } = {},
): Promise<PersistWorkingStateResult> {
  const stateWrite = await c.state.write(workingState);
  if (!stateWrite.ok || options.flush !== true) return { stateWrite };
  return {
    stateWrite,
    stateFlush: await c.state.flush(),
  };
}

export async function saveBlobSnapshot(
  c: SubstrateContext,
  blob: HistoriaBlobV5,
): Promise<StorageWriteResponse> {
  return c.blob.put(CURRENT_BLOB_KEY, encodeCbor(blob));
}

export async function commitSnapshot(
  c: SubstrateContext,
  blob: HistoriaBlobV5,
): Promise<CommitSnapshotResult> {
  const blobWrite = await saveBlobSnapshot(c, blob);
  const emptyState = emptyWorkingState(c.now());
  const stateWrite = blobWrite.ok
    ? await c.state.write(emptyState)
    : ({ ok: false, error: "storageUnavailable", detail: { skipped: "blobWriteFailed" } } as const);
  const stateFlush = stateWrite.ok ? await c.state.flush() : undefined;
  return { blobWrite, stateWrite, stateFlush };
}
