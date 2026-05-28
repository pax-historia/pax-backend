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
- loads scenario manifests and optional nemesis profiles
- loads declarative scenario workload plans from `clients/workload.mts`
  with fixture kinds for allowed players, initial state/blob, and
  gateway `api-responses`
- resolves workload fixture paths and emits a runtime environment plan,
  including `PAX_API_REPLAY_FIXTURES_PATH` when an `api-responses` fixture
  is present
- summarizes `metrics.emit` and capacity warnings into a replay attribution sentence
- runs every substrate guarantee oracle from `@pax-backend/oracles-lib` by default
- can narrow replay checks with `--oracles scenario` or an explicit comma-separated list
- can override fixture resolution with `--fixture-base-dir`
- emits a `result.json`-shaped object with oracle summaries, attribution
  placeholders, scenario metadata, nemesis metadata, and run metadata

It does not yet execute the workload phases, inject nemesis actions, start the
planned runtime environment, shrink fuzz failures, or spin driver machines.
Those stay as later source passes.
