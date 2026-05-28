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
  including `PAX_TEST_SEED` from the scenario manifest and
  `PAX_API_REPLAY_FIXTURES_PATH` when an `api-responses` fixture is present
- executes the first live workload phase set against a running local/live
  substrate: `seed-fixtures`, `register-api-kinds`, `open-sessions`,
  `expect-ws-refusals`, `send-json`, `send-host-events`, `flip-bundles`,
  `wait`, `close-sessions`, `await-nemesis`, and `expect-history-events`
- schedules nemesis profile actions alongside the live workload; the
  `shard-death-every-5m` profile currently maps `kill-shard` to the
  production admin drain endpoint (`POST /admin/shards/:id/drain`)
- summarizes `metrics.emit` and capacity warnings into a replay attribution sentence
- runs every substrate guarantee oracle from `@pax-backend/oracles-lib` by default
- can narrow replay checks with `--oracles scenario` or an explicit comma-separated list
- can override fixture resolution with `--fixture-base-dir`
- can override workload game IDs with `--game-id-prefix`
- can target non-default live endpoints with `--control-url`, `--router-url`,
  and `--phase-timeout-ms`
- can run a whole catalog with `--suite <dir>`, producing one history/result
  pair per scenario × nemesis combination plus a `suite.result.json` summary
- tags suite runs with `--runtime ivm|noivm`; the local stack still needs to be
  started with matching `PAX_CHILD_RUNNER_KIND`, which
  [`scripts/test/scenario-suite-local.sh`](../../scripts/test/scenario-suite-local.sh)
  does for both runtimes
- can set `PAX_SCENARIO_EXPECT_HISTORY_MODE=delay` for split deployments
  where control-plane history cannot see shard-local events during live
  workload pacing; final oracle replay still verifies the merged history
- emits a `result.json`-shaped object with oracle summaries, attribution
  placeholders, scenario metadata, nemesis metadata, and run metadata

It does not yet execute the later stress-only phase families
(`invoke-api`, `state-blob-churn`, `sleep-wake`), start the planned runtime
environment, shrink fuzz failures, or spin driver machines. Those stay as
later source passes.

## Suite mode

Run one catalog against an already-running local or remote stack:

```bash
pnpm exec tsx testing/scenario-runner/src/cli.mts \
  --suite testing/scenarios \
  --runtime ivm \
  --nemeses all \
  --output-dir var/scenario-suite/ivm/testing
```

`--nemeses all` discovers every `testing/nemeses/*/fault-profile.mts`; use a
comma-separated list such as `--nemeses no-faults,shard-death-every-5m` to
pin the matrix. `--scenarios` can likewise narrow the catalog.

For the local runtime matrix:

```bash
PAX_SCENARIO_SUITE_CATALOGS=testing/scenarios \
  scripts/test/scenario-suite-local.sh
```

The script restarts the local stack once with `PAX_CHILD_RUNNER_KIND=ivm` and
once with `PAX_CHILD_RUNNER_KIND=noivm`, then invokes suite mode for each
catalog. CI can use the same contract with an explicit runtime matrix.
