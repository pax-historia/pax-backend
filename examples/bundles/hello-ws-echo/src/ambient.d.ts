// Ambient declarations for the substrate runtime symbols that the child
// runner injects into the isolated-vm context. Bundle authors should never
// reference these directly — esbuild's footer wires __pax_install to the
// bundle's default export at compile time.

import type { BundleDefinition } from "@pax-backend/runtime-sdk";

declare global {
  // Injected by runtime/child-runner-ivm before the bundle source runs.
  function __pax_install(bundle: BundleDefinition): void;
}

export {};
