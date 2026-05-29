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
