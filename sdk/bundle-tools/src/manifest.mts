import type { BundleDefinition, BundleManifest } from "@pax-backend/runtime-sdk";

export function extractManifestFromBundleSource(source: string): BundleManifest {
  let captured: BundleDefinition | undefined;
  const install = (bundle: BundleDefinition): void => {
    captured = bundle;
  };
  const runner = new Function("__pax_install", source) as (
    install: (bundle: BundleDefinition) => void,
  ) => void;
  runner(install);
  if (!captured?.manifest) {
    throw new Error("bundle did not install a definition with a manifest");
  }
  return captured.manifest;
}
