# `.github/workflows/`

Per-zone deploy workflows live here. Each workflow uses a Fly API token
scoped to its target app — the shard-deploy token has no permission to deploy
the control app, and vice versa. CI rejects PRs that touch more than one
zone.

To land:

- `deploy-shards.yml` → `pax-backend-shards` (triggered on `runtime/**` and `vendor/rivet/**` changes)
- `deploy-control.yml` → `pax-backend-control` (triggered on `orchestration/**` changes)
- `deploy-driver.yml` → `pax-backend-driver` (triggered on `tooling/scenario-runner/**` changes; only used when a scenario run is requested)
- `publish-sdk.yml` → npm (triggered on `sdk/**` changes; publishes `@pax-backend/runtime-sdk` and `@pax-backend/runtime-sdk-test-harness`)
- `ci.yml` → cross-zone gates: lint, unit tests, the no-ivm conformance run, the substrate-side oracle suite

Stub.
