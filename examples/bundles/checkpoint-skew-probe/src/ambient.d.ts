import type { BundleDefinition } from "@pax-backend/runtime-sdk";

declare global {
  function __pax_install(bundle: BundleDefinition): void;
}

export {};
