# pax-backend roadmap

The substrate ships in phases. Each is one paragraph of directive plus one sentence of exit signal. Status is one of `complete`, `in_progress`, `to_do`, or `superseded`. Status transitions flow forward only.

Phases 0-5 built the v1 substrate and climbed it on a vendored Rivet runtime; the Phase 5 soak surfaced Rivet's `workflow_worker`/RocksDB ceiling and the per-game process cost, which motivated the Broker/Runner + one-state-object redesign now described in `[docs-next/](../docs-next/)`. Phases 6-11 rebuild the runtime on that architecture, redoing the rewrite → build → deploy → harden → scale arc.

Per-phase notes live in `phase-N/task-tracker.md` (table of tasks with short progress notes per task) and `phase-N/scratchpad.md` (append-only timestamped ledger of what was done, what worked, what didn't, and design decisions made along the way).

## Status board


| Phase                           | Status       | Tasks                                                | Scratchpad                                       |
| ------------------------------- | ------------ | ---------------------------------------------------- | ------------------------------------------------ |
| 0 — Scaffold completion         | `complete`   | [phase-0/task-tracker.md](phase-0/task-tracker.md)   | [phase-0/scratchpad.md](phase-0/scratchpad.md)   |
| 1 — Local Mac build + smoke     | `complete`   | [phase-1/task-tracker.md](phase-1/task-tracker.md)   | [phase-1/scratchpad.md](phase-1/scratchpad.md)   |
| 2 — Fly medium-scale proof      | `complete`   | [phase-2/task-tracker.md](phase-2/task-tracker.md)   | [phase-2/scratchpad.md](phase-2/scratchpad.md)   |
| 3 — historia-default port       | `complete`   | [phase-3/task-tracker.md](phase-3/task-tracker.md)   | [phase-3/scratchpad.md](phase-3/scratchpad.md)   |
| 4 — Adversarial correctness     | `complete`   | [phase-4/task-tracker.md](phase-4/task-tracker.md)   | [phase-4/scratchpad.md](phase-4/scratchpad.md)   |
| 5 — Scale climb to v1           | `superseded` | [phase-5/task-tracker.md](phase-5/task-tracker.md)   | [phase-5/scratchpad.md](phase-5/scratchpad.md)   |
| 6 — Pause and pivot             | `complete`   | [phase-6/task-tracker.md](phase-6/task-tracker.md)   | [phase-6/scratchpad.md](phase-6/scratchpad.md)   |
| 7 — Runtime rewrite (code only) | `complete`   | [phase-7/task-tracker.md](phase-7/task-tracker.md)   | [phase-7/scratchpad.md](phase-7/scratchpad.md)   |
| 8 — Local build + smoke         | `complete`   | [phase-8/task-tracker.md](phase-8/task-tracker.md)   | [phase-8/scratchpad.md](phase-8/scratchpad.md)   |
| 9 — Fly topology proof          | `in_progress` | [phase-9/task-tracker.md](phase-9/task-tracker.md)   | [phase-9/scratchpad.md](phase-9/scratchpad.md)   |
| 10 — Adversarial correctness    | `to_do`      | [phase-10/task-tracker.md](phase-10/task-tracker.md) | [phase-10/scratchpad.md](phase-10/scratchpad.md) |
| 11 — Scale climb to the wall    | `to_do`      | [phase-11/task-tracker.md](phase-11/task-tracker.md) | [phase-11/scratchpad.md](phase-11/scratchpad.md) |


## Phase 0 — Scaffold completion

Every page in `[docs-next/](../docs-next/)` maps to production-shaped code in the repo. Shape must be right and complete; testing comes later. The current scaffold is roughly seventy percent there; remaining gaps cluster in Tigris-canonical storage (state, blobs, bundles), the shard-image Dockerfile, the live execution path in the scenario-runner, host-event delivery (guarantee #17), and the Vector + OTel observability scaffolding.

**Exit signal.** Opening any file under `[docs-next/](../docs-next/)` leads to implementation in the repo that looks production-shaped, not stubbed, whether or not it has been tested.

## Phase 1 — Local Mac build + smoke

This Mac runs the full build matrix and produces a green smoke run with no production secrets. Fix every compilation error and document every macOS-specific toolchain gotcha along the way. Audit dependencies and bump where the upgrade is a small version step with at most a small migration; for anything that would take a heroic effort to patch, log it as a known issue in this phase's [scratchpad](phase-1/scratchpad.md) and move on.

**Exit signal.** `pnpm smoke` runs green on this Mac with no `.env` from production, and `pnpm audit` plus `cargo audit` are either clean or have each remaining finding logged in the scratchpad with a short rationale.

## Phase 2 — Fly medium-scale proof

Bring up the three Fly apps with their Tigris and Upstash backing, and prove the substrate hosts roughly a hundred concurrent hello-world games end-to-end with the full observability pipeline live. This is the topology proof, not a scale proof — the goal is to show every piece works in production shape.

**Exit signal.** A hundred games sustain thirty minutes on Fly with all seventeen guarantee oracles green under both the no-fault and shard-death-every-five-minutes profiles, and at least one continuous end-to-end trace exemplar (placement through URL service and back) is visible in the observability sink.

## Phase 3 — historia-default port

Reimplement Pax-historia's game-session backend as the single substrate-resident bundle at `[examples/bundles/historia-default/](../examples/bundles/historia-default/)`, specifying its five URL service dependencies as specs and fixtures rather than real servers. Any substrate bug surfaced by the port gets fixed in place — this phase is where the contract earns its keep.

**Exit signal.** The full `historia-default` scenario suite runs green locally and on Fly, with all seventeen substrate oracles plus every bundle-correctness oracle passing on every scenario.

## Phase 4 — Adversarial correctness

Stop trying to make the happy path work; start actively trying to break the substrate. Compromised-bundle scenarios, race conditions, stolen JWTs, compute-budget edges, partition nemeses, rolling-deploy collisions. Any genuine failure gets either a fix or an explicit weakened-guarantee doc plus matching oracle — never silent degradation.

**Exit signal.** The full scenario suite, under every nemesis profile, on both `ivm` and `noivm` runtimes, passes in CI as the release gate.

## Phase 5 — Scale climb to v1

> `superseded` by Phase 6. The soak repeatedly hit Rivet's `workflow_worker`/RocksDB ceiling at a thousand games; that evidence motivated the Broker/Runner pivot. The exit signal below is retired — the new scale target lives in Phase 11.

Climb the scale ladder in rungs from a hundred to a thousand concurrent games, across one to ten shard machines. Use the scenario-runner's attribution sentences to drive performance work and to close observability gaps as you go. The substrate must narrate itself well enough to explain every regression it hits.

**Exit signal.** A twenty-four-hour soak at one thousand games across ten shard machines under the full nemesis suite stays green, every observed cliff has documented attribution, and cost projections through ten thousand games are on file.

## Phase 6 — Pause and pivot

Stop the in-flight Phase 5 soak, capture its clean-hour checkpoint and Rivet-cliff evidence into the Phase 5 ledger, and tear the Rivet runtime infra down to zero cost — scale `pax-backend-shards` to zero and stop the driver (the teardown allowlist stays hard-coded; do not generalize it). Then reframe this roadmap onto the Broker/Runner arc and scaffold the phase-6 through phase-11 folders.

**Exit signal.** The soak is stopped with its evidence archived, the Fly runtime apps cost nothing, and this README reads as the new architecture's rewrite-to-scale arc with Phase 5 closed out as `superseded`.

## Phase 7 — Runtime rewrite (code only)

Make every `[docs-next/](../docs-next/)` page map to production-shaped code on the new architecture: the Broker (WebSocket termination, sessions, the eight budgets, identity stamping, capacity watermarks, sole credential holder), the per-game state-store with its atomic checkpoint engine, the Runner pool hosting many isolates per credential-less process over the async `c.`* bridge, and the removal of Rivet (workflow engine, pegboard, guard/tunnel, per-actor RocksDB) from the runtime path. This also brings the placement router up from its smoke-grade port to the scalable, single-writer design in [docs-next/subsystems/placement-and-wake.md](../docs-next/subsystems/placement-and-wake.md) — cached shard table, a directory that shards by `gameId`, an atomic generation-fenced claim, and Fly-proxy WS routing. Code only — packages must typecheck, but nothing runs end-to-end yet.

**Exit signal.** Opening any `docs-next/` page leads to production-shaped, not stubbed, code; every package typechecks; and no `applySyncPromise`, Rivet runtime dependency, or process-per-game model remains in the runtime path.

## Phase 8 — Local build + smoke

Get the new runtime green on this Mac with no production secrets: run the full build matrix, then a smoke run that brings up one Broker and a Runner pool hosting many isolates, exercises the async bridge, writes an atomic checkpoint, and cold-wakes a game from its root object. Re-audit dependencies and log residual findings as before.

**Exit signal.** `pnpm smoke` runs green on this Mac on the new runtime with no `.env` from production, and `pnpm audit` (plus `cargo audit` if any Rust remains) is clean or has each finding logged with a short rationale.

## Phase 9 — Fly topology proof

Re-bootstrap the three Fly apps fresh on the new shard image — Broker plus Runner pool, no per-shard RocksDB volume — and prove the substrate hosts roughly a hundred concurrent games end-to-end with the full observability pipeline live. Validate the one genuinely new transport piece, Fly-proxy WebSocket machine routing, end to end. This is the topology proof, not a scale proof.

**Exit signal.** A hundred games sustain thirty minutes on Fly with all guarantee oracles green under both the no-fault and shard-death-every-five-minutes profiles, and one continuous placement-through-URL-service trace exemplar is visible in the observability sink.

## Phase 10 — Adversarial correctness

Try to break the new invariants with fast oracles: native-crash blast radius bounded by isolates-per-Runner (and the `K=1` strict case), checkpoint-interval durability with zero loss on planned transitions, one consistent snapshot with no state/blob skew on crash, conditional-PUT fencing of a superseded shard, time-travel view and revert-forward restore, and credential-less Runner isolation. Re-validate `historia-default` under checkpoint durability. Any real failure gets a fix or an explicit weakened-guarantee doc plus matching oracle — never silent degradation.

**Exit signal.** The full scenario suite, under every nemesis profile on both `ivm` and `noivm`, including the new-invariant oracles, passes in CI as the release gate.

## Phase 11 — Scale climb to the wall

Climb a density-first scale ladder — many isolates per Runner — first doing ~10m runs from a thousand games toward the hundred-thousand-on-ten-shards the redesign predicts, driven by the scenario-runner's attribution sentences, until the new bottleneck appears (Broker event loop, WebSocket fan-out, checkpoint PUT rate, or Runner CPU). Your first job here is to test the limits of each system, don't just default (for example) to an overly slow and conservative 'ramp up schedule'. Push every metric as aggressive as possible until something *snaps*. Refresh the cost projection on the no-central-write-head model where idle games are free. If you need to here, you may add as many 'driver' Fly instances as needed!

**Exit signal.** A twenty-four-hour soak at the highest sustained concurrency stays green under the full nemesis suite, every observed cliff has documented attribution, and refreshed cost projections toward a hundred thousand games are on file.
