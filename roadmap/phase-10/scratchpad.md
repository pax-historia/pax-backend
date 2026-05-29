# Phase 10 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-29 06:59 PDT

Opened Phase 10 after the Phase 9 Fly topology proof completed. The directive
is to attack the new runtime invariants with fast oracles: native-crash blast
radius, checkpoint-window durability, state/blob snapshot consistency,
conditional-PUT fencing for superseded shards, time-travel restore, and
credential-less Runner isolation. The exit signal is the full scenario suite
under every nemesis on both `ivm` and `noivm`, including the new-invariant
oracles, passing in CI as the release gate.

First task is a surface audit across the oracle library, scenario-runner,
nemesis profiles, CI release gate, and updated guarantees doc before adding or
running new adversarial work.

## 2026-05-29 07:04 PDT

Completed the Phase 10 surface audit and expanded the task tracker. The current
CI release gate is already wired as a broad matrix for the first-party
`testing/scenarios` catalog: `scripts/test/scenario-suite-local.sh` restarts the
local stack for `ivm` and `noivm`, runs every discovered scenario against every
discovered nemesis, and `.github/workflows/scenario-suite.yml` invokes that
contract with `PAX_SCENARIO_SUITE_ORACLES=scenario`.

The audit found four important gaps before Phase 10 can be called real:

- Native Runner crashes are not injectable today. The nemesis catalog only has
  `no-faults`, `shard-death-every-5m`, and `api-kind-partition-burst`; the
  Runner wrapper records child exits internally but does not emit the
  `runner.crash` history event described in `docs-next/reference/event-schema.md`.
  The `crash-blast-radius` oracle can react to `runner.crash`, but no workload
  currently creates that evidence or proves the strict `K = 1` case.
- The credential-less Runner invariant appears broken in implementation:
  `spawnRunnerChildProcess` passes `...process.env` into the child process, so
  Broker-held values such as Tigris keys and `PAX_JWT_SECRET` can leak into the
  Runner environment. This needs a tight allowlist before any adversarial
  isolation proof is meaningful.
- The state/blob durability oracles are too weak for the new state-store
  contract. `state-durability` and `blob-durability` currently only remember
  that a successful write happened and fail if a later read/get is missing.
  They do not check checkpoint sequence monotonicity, planned-transition zero
  loss, unplanned checkpoint-window bounds, `state.checkpoint`, or state/blob
  skew around a torn commit. Runtime history currently emits `state.flush` and
  `state.flush.plannedTransition`, while the desired event schema names
  `state.checkpoint` and `state.restore`.
- Time travel and restore-forward are implemented in `runtime/state-store`, but
  the control-plane admin API does not expose the checkpoint chain. Its
  `/admin/games/:id/snapshot` response still reads the older Redis storage raw
  keys, and there are no `/checkpoints` or `/restore` workload phases/oracles.

Two suite-shape gaps also matter. First, conditional-PUT fencing exists in the
state-store adapters, but there is no superseded-shard race scenario that
forces a `ConditionalPutConflict` and proves the stale owner stands down.
Second, the `historia-default` scenario catalog exists under
`examples/bundles/historia-default/scenarios`, but the CI release gate currently
sets `PAX_SCENARIO_SUITE_CATALOGS=testing/scenarios`, so Phase 10 still needs a
checkpoint-durability revalidation pass for the historia proof bundle.

## 2026-05-29 07:08 PDT

Started Task 2 with the credential boundary fix. The Runner child spawn path no
longer spreads `process.env`; it builds a small bootstrap environment from
non-secret process necessities (`PATH`, home/temp/color/CI style keys) and then
overlays the explicit `PAX_RUNNER_*` values the child host needs to start.
Caller-provided env values go through the same bootstrap allowlist, so accidental
`AWS_*`, `REDIS_URL`, `PAX_JWT_SECRET`, Tigris bucket/key, or Better Stack
values cannot be smuggled through `options.env`.

Verification so far: `pnpm --filter @pax-backend/runner check-types` passed, and
a direct `buildRunnerChildEnv` probe with fake JWT/S3/Redis/Tigris keys confirmed
the forbidden names were not present while `PAX_RUNNER_CHILD`,
`PAX_RUNNER_ID`, and `PAX_RUNNER_KIND` were still set.

## 2026-05-29 07:17 PDT

Landed the first native-crash signal path. `ChildProcessRunnerProcess` now
captures the assigned game IDs before an unexpected child exit clears them, then
notifies the Broker-side spawn callback. The `RunnerPool` can replace a dead
Runner in-place so the crashed child does not keep winning future assignments
with an empty `assignedGames` set. The Broker writes `runner.crash` with
`affectedGameIds`, removes the crashed games from the old active directory
claim, closes their sessions, and immediately wakes them from storage on the
replacement Runner with `onWake.reason = cold-restart-after-crash`, followed by
`isolate.restart`.

Added a deterministic local injection hook at
`POST /admin/runners/:runnerId/crash`, backed by `SIGKILL` on the child process.
This is intentionally an admin/test hook, not a creator surface. The event schema
now uses `runnerId` for `runner.crash`, and `history-completeness` requires the
new restart/crash event fields.

Verification: `pnpm --filter @pax-backend/runner check-types`,
`pnpm --filter @pax-backend/oracles-lib check-types`,
`pnpm --filter @pax-backend/broker check-types`, and full `pnpm typecheck`
passed. Running the actual nemesis/oracle proof is still pending; the next
Task 2 slice should add a runner-crash nemesis or workload phase and assert the
K-bound explicitly.

## 2026-05-29 07:26 PDT

Completed the Task 2 proof loop. Added the `runner-crash-on-await` nemesis and
`runner-crash-blast-radius` scenario, with a local oracle that requires
`runner.crash`, nonempty `affectedGameIds`, a bounded affected set, and
`isolate.restart` for every affected game. The shared `crash-blast-radius`
oracle now checks `affectedGameIds.length <= maxAssignedGames` for Runner
crashes.

The Broker now coalesces concurrent wake attempts per game so reconnects cannot
race the post-crash restart path. The scenario history collector also preserves
runner-scoped `runner.crash` records by matching `affectedGameIds` against the
scenario games and appending control-plane history as one sorted batch, so
streaming oracles see crash-before-restart ordering.

Verification:

- `pnpm typecheck`
- `pnpm build:bundles`
- `PAX_SCENARIO_SUITE_RUNTIMES=noivm PAX_SCENARIO_SUITE_SCENARIOS=runner-crash-blast-radius PAX_SCENARIO_SUITE_NEMESES=runner-crash-on-await PAX_SCENARIO_SUITE_PHASE_TIMEOUT_MS=60000 ./scripts/test/scenario-suite-local.sh`
- `PAX_RUNNER_PROCESS_COUNT=2 PAX_RUNNER_MAX_ASSIGNED_GAMES=1 PAX_SCENARIO_SUITE_RUNTIMES=noivm PAX_SCENARIO_SUITE_SCENARIOS=runner-crash-blast-radius PAX_SCENARIO_SUITE_NEMESES=runner-crash-on-await PAX_SCENARIO_SUITE_PHASE_TIMEOUT_MS=60000 ./scripts/test/scenario-suite-local.sh`

The strict K run recorded `maxAssignedGames: 1` and exactly one affected game.

## 2026-05-29 07:44 PDT

Completed Task 3's checkpoint-window proof. The Broker now supports an optional
interval checkpoint timer (`PAX_STATE_CHECKPOINT_INTERVAL_MS`, defaulted to
`1000` in the local stack) that schedules `state.checkpoint` after successful
dirty state/blob operations and cancels cleanly on explicit flushes, planned
release, and Runner-crash removal. `state.write`, `blob.put`, `state.flush`,
`state.flush.plannedTransition`, and `state.checkpoint` now carry enough
success/sequence metadata for durability oracles to reason about checkpoint
progress.

Added `examples/bundles/checkpoint-skew-probe`, which writes matching markers
into `c.state` and a blob key, emits probe markers from `onWake` and
`onPlayerMessage`, and can deliberately leave a dirty marker unflushed. The new
`checkpoint-durability-consistency` scenario uses that bundle to prove four
cases in one path: an explicit committed marker, an interval-checkpointed marker
that survives a Runner crash, an unplanned dirty marker that rolls back to the
last checkpoint after a Runner crash, and a planned dirty marker that survives
admin eviction through `state.flush.plannedTransition`.

The scenario-runner now has a planned `evict-games` workload phase, using the
session's placed shard URL to call the Broker admin eviction hook and wait for
target sessions to close. While running the all-nemesis matrix, the shared
`crash-blast-radius` oracle was tightened for scenario-sliced histories: a
Runner crash may report idle games left over from earlier nemesis runs, so the
oracle keeps the full K-bound check but only requires `isolate.restart` for
affected games present in the current history slice.

Verification:

- `pnpm typecheck`
- `pnpm build:bundles`
- `git diff --check`
- `PAX_SCENARIO_SUITE_RUNTIMES=noivm PAX_SCENARIO_SUITE_SCENARIOS=checkpoint-durability-consistency PAX_SCENARIO_SUITE_NEMESES=runner-crash-on-await PAX_SCENARIO_SUITE_PHASE_TIMEOUT_MS=60000 ./scripts/test/scenario-suite-local.sh`
- `PAX_SCENARIO_SUITE_RUNTIMES=ivm PAX_SCENARIO_SUITE_SCENARIOS=checkpoint-durability-consistency PAX_SCENARIO_SUITE_NEMESES=runner-crash-on-await PAX_SCENARIO_SUITE_PHASE_TIMEOUT_MS=60000 ./scripts/test/scenario-suite-local.sh`
- `PAX_SCENARIO_SUITE_RUNTIMES=noivm PAX_SCENARIO_SUITE_SCENARIOS=checkpoint-durability-consistency PAX_SCENARIO_SUITE_NEMESES=all PAX_SCENARIO_SUITE_PHASE_TIMEOUT_MS=60000 ./scripts/test/scenario-suite-local.sh`
- `PAX_SCENARIO_SUITE_RUNTIMES=ivm PAX_SCENARIO_SUITE_SCENARIOS=checkpoint-durability-consistency PAX_SCENARIO_SUITE_NEMESES=all PAX_SCENARIO_SUITE_PHASE_TIMEOUT_MS=60000 ./scripts/test/scenario-suite-local.sh`

## 2026-05-29 07:57 PDT

Completed Task 4's conditional-PUT fencing proof. Added an admin/test
`/admin/games/:gameId/fence-winner` hook that writes a fresh state-store root
through an independent session, emits `state.fence.winner`, and lets the active
owner discover the stale root with the real conditional PUT guard. The Broker
now records `state.fence.conflict`, returns a structured
`conditionalPutConflict` storage response to the Runner, stands the superseded
game down, releases its active directory claim, closes sessions, releases the
Runner assignment, emits `game.stoodDown`, and preserves the winning root for
cold wake.

The scenario-runner has a matching `inject-fence-winner` workload phase. The new
`conditional-put-fencing` scenario commits a base marker, leaves a stale dirty
marker in the active owner, injects the independent winning root, forces the
stale owner to flush and stand down, then reconnects and proves both state and
blob reads observe the winner marker. Shared history, singleton, state
durability, and blob durability oracles now understand the fence winner/conflict
boundary so they do not treat the intentional supersession as data loss.

Verification:

- `pnpm --filter @pax-backend/oracles-lib check-types`
- `pnpm --filter @pax-backend/broker check-types`
- `pnpm --filter @pax-backend/scenario-runner check-types`
- `PAX_SCENARIO_SUITE_RUNTIMES=noivm,ivm PAX_SCENARIO_SUITE_SCENARIOS=conditional-put-fencing PAX_SCENARIO_SUITE_NEMESES=all PAX_SCENARIO_SUITE_PHASE_TIMEOUT_MS=60000 ./scripts/test/scenario-suite-local.sh`
- `pnpm typecheck`
- `pnpm build:bundles`
- `git diff --check`
