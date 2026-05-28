# `sdk/` — what creators install

The typed surface that creator bundles import. The SDK is the contract in code
form: every guarantee in [plan](../README.md) §"Strong platform guarantees"
maps to either an SDK type, an SDK lifecycle hook, or an SDK call.

The SDK ships separately from the runtime so creators can install it and
write code locally without the runtime, and the runtime can swap underlying
implementations (different inner sandbox, future Bun isolate, etc.) without
breaking the SDK.

## Contents

| Path | Package |
|---|---|
| `runtime-sdk/` | `@pax-backend/runtime-sdk`. The typed `c.*` surface: lifecycle hook types, channel signatures, `BundleManifest`, the local pre-publish validator that mirrors the admin endpoint's `compatTagProduced ∈ compatTagsAccepted` check. |
| `runtime-sdk-test-harness/` | `@pax-backend/runtime-sdk-test-harness`. Local dev loop with record/replay against canned fixtures, the seed-pinned PRNG, and the in-memory `connectedSessions` simulator. Lets creators write tests without standing up Fly. |
