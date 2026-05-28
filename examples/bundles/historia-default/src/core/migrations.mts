import {
  emptyBlob,
  isHistoriaCompatTag,
  normalizeBlobV5,
  type HistoriaBlobV5,
  type HistoriaCompatTag,
} from "./schema.mjs";

export interface MigrationResult {
  readonly blob: HistoriaBlobV5;
  readonly migratedFrom?: HistoriaCompatTag;
}

export function migrateBlobToV5(
  value: unknown,
  blobCompatTag: string | undefined,
  now: number,
): MigrationResult {
  const sourceTag = isHistoriaCompatTag(blobCompatTag) ? blobCompatTag : "historia:v5";
  if (value === undefined) {
    return { blob: emptyBlob(now) };
  }
  if (sourceTag === "historia:v5") {
    return { blob: normalizeBlobV5(value, now) };
  }
  return {
    blob: {
      ...normalizeBlobV5(value, now),
      compatTag: "historia:v5",
      updatedAt: now,
      migration: {
        fromCompatTag: sourceTag,
        migratedAt: now,
      },
    },
    migratedFrom: sourceTag,
  };
}
