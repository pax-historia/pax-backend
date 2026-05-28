import type { BundleManifest } from "@pax-backend/ipc-protocol";

import type { BundleHandlers } from "./lifecycle.mjs";

export type { BundleManifest } from "@pax-backend/ipc-protocol";

export interface BundleDefinition extends BundleHandlers {
  readonly manifest: BundleManifest;
}

/**
 * Validates the manifest in-band (matches the upload-time check the admin
 * endpoint will do at POST /admin/bundles/:name) and returns the
 * definition. Throws if the manifest is internally inconsistent.
 *
 * Same validator runs:
 *   - Host-side when the parent extracts a bundle's manifest before publish
 *   - In-isolate at bundle eval (every cold-start)
 *   - At publish time on the admin upload (M2+)
 */
export function defineBundle<T extends BundleDefinition>(def: T): T {
  if (!def || typeof def !== "object") {
    throw new Error("defineBundle: definition must be an object");
  }
  const m = def.manifest;
  if (!m || typeof m !== "object") {
    throw new Error("defineBundle: manifest is required");
  }
  if (typeof m.compatTagProduced !== "string" || m.compatTagProduced.length === 0) {
    throw new Error("defineBundle: manifest.compatTagProduced must be a non-empty string");
  }
  if (!Array.isArray(m.compatTagsAccepted) || m.compatTagsAccepted.length === 0) {
    throw new Error("defineBundle: manifest.compatTagsAccepted must be a non-empty array");
  }
  if (!m.compatTagsAccepted.includes(m.compatTagProduced)) {
    throw new Error(
      `defineBundle: compatTagProduced (${m.compatTagProduced}) must appear in compatTagsAccepted (${JSON.stringify(
        m.compatTagsAccepted,
      )}) - a bundle must be able to read what it writes`,
    );
  }
  if (!Number.isInteger(m.runtimeContractRequired) || m.runtimeContractRequired < 1) {
    throw new Error("defineBundle: manifest.runtimeContractRequired must be a positive integer");
  }
  return def;
}
