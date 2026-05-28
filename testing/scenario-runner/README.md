# `testing/scenario-runner/`

The scenario-bundle harness. One artifact (scenario bundle) → three run
modes (`load`, `property`, `fuzz`) → one set of oracles → a
determinism-level claim. Plus replay mode for cross-version oracle
re-runs.

Deploys to `pax-backend-driver` Fly machines on demand. Treat any
substrate-side oracle violation in CI as a release blocker.

See [`../README.md`](../README.md) for the broader rules about the
`testing/` zone.

Current source pass provides the first runner shell:

- reads a history JSONL file
- runs every substrate guarantee oracle from `@pax-backend/oracles-lib`
- emits a `result.json`-shaped object with oracle summaries, attribution
  placeholders, and run metadata

It does not yet drive clients, compose nemeses, shrink fuzz failures, or spin
driver machines. Those stay as later source passes.
