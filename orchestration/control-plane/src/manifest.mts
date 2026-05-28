import type { BundleManifest } from "@pax-backend/ipc-protocol";

export interface CompatCheckOk {
  readonly ok: true;
}

export interface CompatCheckRefused {
  readonly ok: false;
  readonly error: "compatTagOutOfRange";
  readonly blobCompatTag: string;
  readonly bundleCompatTagsAccepted: readonly string[];
}

export type CompatCheckResult = CompatCheckOk | CompatCheckRefused;

export function assertBundleManifest(value: unknown): BundleManifest {
  if (!isRecord(value)) {
    throw new Error("manifest must be an object");
  }
  const compatTagProduced = value["compatTagProduced"];
  const compatTagsAccepted = value["compatTagsAccepted"];
  const runtimeContractRequired = value["runtimeContractRequired"];
  if (typeof compatTagProduced !== "string" || compatTagProduced.length === 0) {
    throw new Error("manifest.compatTagProduced must be a non-empty string");
  }
  if (
    !Array.isArray(compatTagsAccepted) ||
    compatTagsAccepted.length === 0 ||
    !compatTagsAccepted.every((tag) => typeof tag === "string" && tag.length > 0)
  ) {
    throw new Error("manifest.compatTagsAccepted must be a non-empty string array");
  }
  if (!compatTagsAccepted.includes(compatTagProduced)) {
    throw new Error("compatTagProduced must appear in compatTagsAccepted");
  }
  if (!Number.isInteger(runtimeContractRequired) || runtimeContractRequired < 1) {
    throw new Error("manifest.runtimeContractRequired must be a positive integer");
  }
  return {
    compatTagProduced,
    compatTagsAccepted,
    runtimeContractRequired,
  };
}

export function checkBundleCompat(
  blobCompatTag: string | undefined,
  manifest: BundleManifest,
): CompatCheckResult {
  if (blobCompatTag === undefined || manifest.compatTagsAccepted.includes(blobCompatTag)) {
    return { ok: true };
  }
  return {
    ok: false,
    error: "compatTagOutOfRange",
    blobCompatTag,
    bundleCompatTagsAccepted: manifest.compatTagsAccepted,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
