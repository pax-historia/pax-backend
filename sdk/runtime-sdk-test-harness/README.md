# `sdk/runtime-sdk-test-harness/` — `@pax-backend/runtime-sdk-test-harness`

Local dev loop for creator bundles. Implements:

- The seed-pinned PRNG (`c.rng()` / `c.now()`) that backs the determinism dial.
- An in-memory `connectedSessions` simulator so unit tests can exercise the
  `api.invoke` context envelope without touching the cluster.
- Record/replay against canned wire-grain fixtures in
  `fixtures/api-responses/`; hard-fails `replayCoverageGap` when a recorded
  response is missing (same semantics as the production gateway).
- A pre-publish bundle validator: schema-checks the `BundleManifest`,
  lints out raw `Math.random` / `Date.now`, and exercises the bundle through
  the harness with a smoke scenario.

Stub.
