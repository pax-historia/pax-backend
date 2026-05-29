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
  `sleep-wake`, `wait`, `close-sessions`, `await-nemesis`, and
  `expect-history-events`
- schedules nemesis profile actions alongside the live workload; the
  `shard-death-every-5m` profile currently maps `kill-shard` to the
  production admin drain endpoint (`POST /admin/shards/:id/drain`), while
  `api-kind-partition-burst` temporarily rewires an API kind through
  `POST /admin/api-kinds`
- scrapes live Prometheus metrics from router, control-plane, gateway, and
  Broker endpoints during non-replay runs; replay mode still
  summarizes `metrics.emit` and capacity warnings from history
- runs every substrate guarantee oracle from `@pax-backend/oracles-lib` by default
- can narrow replay checks with `--oracles scenario` or an explicit comma-separated list;
  CI uses `--oracles scenario` so adversarial negative scenarios only gate on the
  guarantee oracles their manifests declare plus scenario-local oracles
- can override fixture resolution with `--fixture-base-dir`
- can override workload game IDs with `--game-id-prefix`
- can target non-default live endpoints with `--control-url`, `--router-url`,
  and `--phase-timeout-ms`
- can run a whole catalog with `--suite <dir>`, producing one history/result
  pair per scenario × nemesis combination plus a `suite.result.json` summary
- can run a Phase 5 scale ladder with `--scale-plan <file>`, producing a
  `scale-ladder.result.json` summary plus one `rung.result.json`, history file,
  and scenario `result.json` per rung × nemesis case
- tags suite runs with `--runtime ivm|noivm`; the local stack still needs to be
  started with matching `PAX_RUNNER_KIND`, which
  [`scripts/test/scenario-suite-local.sh`](../../scripts/test/scenario-suite-local.sh)
  does for both runtimes
- can set `PAX_SCENARIO_EXPECT_HISTORY_MODE=delay` for split deployments
  where control-plane history cannot see shard-local events during live
  workload pacing; final oracle replay still verifies the merged history
- emits a `result.json`-shaped object with oracle summaries, attribution
  placeholders, scenario metadata, nemesis metadata, and run metadata

It does not yet execute the later stress-only phase families (`invoke-api`,
`state-blob-churn`), start the planned runtime environment, shrink fuzz
failures, or spin driver machines. Those stay as later source passes.

## Suite mode

Run one catalog against an already-running local or remote stack:

```bash
pnpm exec tsx testing/scenario-runner/src/cli.mts \
  --suite testing/scenarios \
  --runtime ivm \
  --nemeses all \
  --oracles scenario \
  --output-dir var/scenario-suite/ivm/testing
```

`--nemeses all` discovers every `testing/nemeses/*/fault-profile.mts`; use a
comma-separated list such as `--nemeses no-faults,shard-death-every-5m` to
pin the matrix. `--scenarios` can likewise narrow the catalog. Each suite
invocation salts workload game IDs with the suite start timestamp, so repeated
local runs do not collide with prior Redis or Tigris-local state.

For the local runtime matrix:

```bash
PAX_SCENARIO_SUITE_CATALOGS=testing/scenarios,examples/bundles/historia-default/scenarios \
  scripts/test/scenario-suite-local.sh
```

The script restarts the local stack once with `PAX_RUNNER_KIND=ivm` and
once with `PAX_RUNNER_KIND=noivm`, then invokes suite mode for each
catalog. Each runtime gets output-scoped history, API-record, and local Tigris
paths, and output directories use a sanitized catalog path so catalogs with the
same basename do not collide. Narrow it with `PAX_SCENARIO_SUITE_SCENARIOS`,
`PAX_SCENARIO_SUITE_NEMESES`, or `PAX_SCENARIO_SUITE_ORACLES` when iterating
locally. CI uses the same contract.

## Scale ladder mode

Phase 5 rungs are declared in `testing/scale-ladders/v1-scale.mts`. Run a
selected rung against an already-running stack:

```bash
pnpm exec tsx testing/scenario-runner/src/cli.mts \
  --scale-plan testing/scale-ladders/v1-scale.mts \
  --scale-rung 100g-1shard \
  --runtime ivm \
  --oracles scenario \
  --output-dir var/scale-ladder/ivm/100g-1shard
```

Each rung records target game count, shard-machine count, per-case target
duration, nemesis set, sampling profile, attribution sentences, and per-case
history and result paths. The runner applies the rung target to the scenario
workload by overriding `maxGames`, `open-sessions` ramp/session count, and
`send-json` message count derived from the target duration. Rungs may also
override the `send-json` interval and fanout window so long soaks can separate
concurrent session proof from higher-throughput message-rate probes.

For live runs, `sampling_profile` controls metric scrape cadence: `ramp` samples
every 30 seconds and `cliff_hold` every second. The collector aggregates online
instead of retaining raw scrape lines. Override cadence with
`--metrics-scrape-interval-ms` when a short local run needs denser samples.

After each live case, the runner appends archived and control-plane history
before running oracles. Control-plane history is fetched with bounded concurrency
so 1000-game rungs do not pay a fully serial post-run tail; tune it with
`PAX_SCENARIO_CONTROL_HISTORY_CONCURRENCY` when the control plane needs a lower
or higher request fanout. For long scale soaks, set
`PAX_SCENARIO_HISTORY_PROFILE=scale` to keep the local oracle replay history to
contract events needed by the scale oracles plus failure/capacity/budget events;
the full raw history remains in the observability archive.

By default the collector uses one Broker endpoint. For multi-shard rungs, set
`PAX_BROKER_METRICS_URLS` to comma-separated `label=url` entries so
`metrics.per_surface` keeps each shard's samples separate.

Phase 9's Fly topology proof uses
`testing/scale-ladders/phase9-topology.mts`, specifically rung
`100g-3shards-30m-topology`. It keeps the exit target at 100 concurrent games
while requiring three shard machines so the proof exercises placement
distribution, Fly-Replay WebSocket pinning, and shard-death recovery.
