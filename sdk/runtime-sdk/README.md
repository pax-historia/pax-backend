# `sdk/runtime-sdk/` — `@pax-backend/runtime-sdk`

The typed contract surface creators import. Treat the SDK as the contract:
every guarantee in [plan](../../README.md) §"Strong platform guarantees" maps
to either an SDK type, a lifecycle hook signature, or a `c.*` call.

Includes the `BundleManifest` type and a local pre-publish validator that
mirrors the admin endpoint's upload-time check
(`compatTagProduced ∈ compatTagsAccepted`).

Step 4 of the plan's kickoff.

Stub.
