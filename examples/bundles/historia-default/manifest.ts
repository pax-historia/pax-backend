import type { BundleManifest } from "@pax-backend/runtime-sdk";

export const HISTORIA_COMPAT_TAGS = [
  "historia:v1",
  "historia:v2",
  "historia:v3",
  "historia:v4",
  "historia:v5",
] as const;

export const manifest = {
  compatTagProduced: "historia:v5",
  compatTagsAccepted: HISTORIA_COMPAT_TAGS,
  runtimeContractRequired: 1,
} satisfies BundleManifest;
