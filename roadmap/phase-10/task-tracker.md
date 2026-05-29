# Phase 10 — Adversarial correctness

> Status: `in_progress` · Directive and exit signal: [README](../README.md)

## Tasks

Each row is a unit of work — big enough to be a task, not an entire major project, and not a single trivial change. Progress is a few sentences max; for anything that grows beyond that, log the detail in [`scratchpad.md`](scratchpad.md) and keep the cell short. The last row is always a phase-verification task — re-read the directive and exit signal, walk the docs the phase touches, and confirm nothing was missed. If something was, add rows above the verification row and rerun.

| # | Task | Progress |
|---|---|---|
| 1 | **Surface audit** — Re-read this phase's directive/exit signal and the correctness surfaces (`testing/oracles-lib`, `testing/scenario-runner`, the nemesis profiles, the CI release gate, the updated guarantees in [`docs-next/vision/guarantees.md`](../../docs-next/vision/guarantees.md)). Expand this placeholder into a concrete task list. | `to_do` |
| 2 | **Phase verification** — Re-read this phase's directive and exit signal in the [README](../README.md). Confirm the full suite under every nemesis on both runtimes, including the new-invariant oracles, passes in CI as the release gate. If anything is missing, add rows above this one and rerun. | `to_do` |
