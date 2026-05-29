// Ambient declarations for the substrate runtime symbols that the Runner
// injects into the isolate context. Bundle authors should never
// reference these directly — esbuild's footer wires __pax_install to the
// bundle's default export at compile time.

import type { BundleDefinition } from "@pax-backend/runtime-sdk";

declare global {
  // Injected by runtime/runner before the bundle source runs.
  function __pax_install(bundle: BundleDefinition): void;
}

export {};
