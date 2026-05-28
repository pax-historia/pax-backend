# `sdk/` — what creators install on THEIR machine

**Published to npm.** The typed surface for creator bundles + the optional
CLI for building them.

The SDK is the contract written down in code. Everything a creator sees
when they `import` from `@pax-backend/runtime-sdk` lives here, and the
shape of those types matches one-to-one with the channels, lifecycle hooks,
and admin surface in [the plan README](../README.md).

## Contents

| Path | What it is |
|---|---|
| `runtime-sdk/` | `@pax-backend/runtime-sdk`. The typed creator surface: `defineBundle(...)`, `SubstrateContext` (`c`), lifecycle hook signatures (`onWake`, `onPlayerConnect`, `onPlayerMessage`, ...), the manifest type. |
| `runtime-sdk-test-harness/` | `@pax-backend/runtime-sdk-test-harness`. Local dev loop + record/replay for bundle authors who want to run their bundle outside the live shard. |
| `bundle-tools/` | `@pax-backend/bundle-tools`. Creator-facing CLI for building + publishing bundles (esbuild → IIFE → `__pax_install` footer, manifest extraction, upload to `POST /admin/bundles/:bundleName`). Moved from `tooling/` because it runs on the creator's machine, not the driver. |

## Sub-layout convention

```
runtime-sdk/src/
  c/<surface>.ts        # one file per c.* surface (api.ts, ws.ts, state.ts,
                        #   blob.ts, log.ts, lifecycle.ts, players.ts,
                        #   compute.ts, metrics.ts)
  manifest.ts           # BundleManifest type + validator
  define-bundle.ts      # defineBundle() entry point
  types/                # shared types (sessionId, playerId, ...)
  index.mts             # re-exports

bundle-tools/src/
  commands/<command>.ts # one file per CLI command (build.ts, publish.ts,
                        #   verify.ts, ...)
  cli.ts
```

Current source passes ship `runtime-sdk/`, the first
`runtime-sdk-test-harness/` implementation, and the initial `bundle-tools/`
command modules.
