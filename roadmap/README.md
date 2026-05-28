# pax-backend roadmap

The substrate ships in six phases. Each is one paragraph of directive plus one sentence of exit signal. Status is one of three values: `complete`, `in_progress`, `to_do`. Status transitions flow forward only.

Per-phase notes live in `phase-N/task-tracker.md` (table of tasks with short progress notes per task) and `phase-N/scratchpad.md` (append-only timestamped ledger of what was done, what worked, what didn't, and design decisions made along the way).

## Status board

| Phase | Status | Tasks | Scratchpad |
|---|---|---|---|
| 0 — Scaffold completion | `complete` | [phase-0/task-tracker.md](phase-0/task-tracker.md) | [phase-0/scratchpad.md](phase-0/scratchpad.md) |
| 1 — Local Mac build + smoke | `complete` | [phase-1/task-tracker.md](phase-1/task-tracker.md) | [phase-1/scratchpad.md](phase-1/scratchpad.md) |
| 2 — Fly medium-scale proof | `complete` | [phase-2/task-tracker.md](phase-2/task-tracker.md) | [phase-2/scratchpad.md](phase-2/scratchpad.md) |
| 3 — historia-default port | `in_progress` | [phase-3/task-tracker.md](phase-3/task-tracker.md) | [phase-3/scratchpad.md](phase-3/scratchpad.md) |
| 4 — Adversarial correctness | `to_do` | [phase-4/task-tracker.md](phase-4/task-tracker.md) | [phase-4/scratchpad.md](phase-4/scratchpad.md) |
| 5 — Scale climb to v1 | `to_do` | [phase-5/task-tracker.md](phase-5/task-tracker.md) | [phase-5/scratchpad.md](phase-5/scratchpad.md) |

## Phase 0 — Scaffold completion

Every page in [`docs-next/`](../docs-next/) maps to production-shaped code in the repo. Shape must be right and complete; testing comes later. The current scaffold is roughly seventy percent there; remaining gaps cluster in Tigris-canonical storage (state, blobs, bundles), the shard-image Dockerfile, the live execution path in the scenario-runner, host-event delivery (guarantee #17), and the Vector + OTel observability scaffolding.

**Exit signal.** Opening any file under [`docs-next/`](../docs-next/) leads to implementation in the repo that looks production-shaped, not stubbed, whether or not it has been tested.

## Phase 1 — Local Mac build + smoke

This Mac runs the full build matrix and produces a green smoke run with no production secrets. Fix every compilation error and document every macOS-specific toolchain gotcha along the way. Audit dependencies and bump where the upgrade is a small version step with at most a small migration; for anything that would take a heroic effort to patch, log it as a known issue in this phase's [scratchpad](phase-1/scratchpad.md) and move on.

**Exit signal.** `pnpm smoke` runs green on this Mac with no `.env` from production, and `pnpm audit` plus `cargo audit` are either clean or have each remaining finding logged in the scratchpad with a short rationale.

## Phase 2 — Fly medium-scale proof

Bring up the three Fly apps with their Tigris and Upstash backing, and prove the substrate hosts roughly a hundred concurrent hello-world games end-to-end with the full observability pipeline live. This is the topology proof, not a scale proof — the goal is to show every piece works in production shape.

**Exit signal.** A hundred games sustain thirty minutes on Fly with all seventeen guarantee oracles green under both the no-fault and shard-death-every-five-minutes profiles, and at least one continuous end-to-end trace exemplar (placement through URL service and back) is visible in the observability sink.

## Phase 3 — historia-default port

Reimplement Pax-historia's game-session backend as the single substrate-resident bundle at [`examples/bundles/historia-default/`](../examples/bundles/historia-default/), specifying its five URL service dependencies as specs and fixtures rather than real servers. Any substrate bug surfaced by the port gets fixed in place — this phase is where the contract earns its keep.

**Exit signal.** The full `historia-default` scenario suite runs green locally and on Fly, with all seventeen substrate oracles plus every bundle-correctness oracle passing on every scenario.

## Phase 4 — Adversarial correctness

Stop trying to make the happy path work; start actively trying to break the substrate. Compromised-bundle scenarios, race conditions, stolen JWTs, compute-budget edges, partition nemeses, rolling-deploy collisions. Any genuine failure gets either a fix or an explicit weakened-guarantee doc plus matching oracle — never silent degradation.

**Exit signal.** The full scenario suite, under every nemesis profile, on both `ivm` and `noivm` runtimes, passes in CI as the release gate.

## Phase 5 — Scale climb to v1

Climb the scale ladder in rungs from a hundred to a thousand concurrent games, across one to ten shard machines. Use the scenario-runner's attribution sentences to drive performance work and to close observability gaps as you go. The substrate must narrate itself well enough to explain every regression it hits.

**Exit signal.** A twenty-four-hour soak at one thousand games across ten shard machines under the full nemesis suite stays green, every observed cliff has documented attribution, and cost projections through ten thousand games are on file.
