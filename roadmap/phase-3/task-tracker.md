# Phase 3 — historia-default port

> Status: `in_progress` · Directive and exit signal: [README](../README.md)

## Tasks

Each row is a unit of work — big enough to be a task, not an entire major project, and not a single trivial change. Progress is a few sentences max; for anything that grows beyond that, log the detail in [`scratchpad.md`](scratchpad.md) and keep the cell short. The last row is always a phase-verification task — re-read the directive and exit signal, walk the docs the phase touches, and confirm nothing was missed. If something was, add rows above the verification row and rerun.

| # | Task | Progress |
|---|---|---|
| 1 | **URL service spec audit** — Re-read the five schema-only URL service specs (`ai.chat.v1`, `flag.search.v1`, `moderation.audit.v1`, `participation.v1`, `projection.sync.v1`) against [`docs-next/proofs/historia-default.md`](../../docs-next/proofs/historia-default.md) and the bundle README. Close any schema/fixture-contract gaps before bundle code depends on them. | `in_progress` — The five spec README files already exist; the next step is to audit their request/response shapes and fixture expectations against the proof plan. |
| 2 | **Bundle scaffold and build output** — Add the `historia-default` package, manifest, TypeScript config, runtime ambient declarations, and build path that emits `dist/bundle.js` in the same shape as the existing example bundles. | `to_do` |
| 3 | **Core state, blob, and migration adapter** — Implement the `GameContext` adapter over `c.*`, the compact `c.state` working-set layout, `c.blob` snapshot layout, and the `historia:v1` through `historia:v5` migration dispatch. | `to_do` |
| 4 | **Module and workflow port** — Port the seven game-session modules plus supporting modules, default workflow strings, workflow engine, executors, and task tracker into the bundle without adding substrate-specific game concepts. | `to_do` |
| 5 | **Routing, hydration, and policy gates** — Wire `onWake`, `onSleep`, `onPlayerConnect`, `onPlayerDisconnect`, `onPlayerMessage`, `onCapacityWarning`, and `onHostEvent` to module dispatch, initial snapshots, permissions, offline caps, and participation-aware policy checks. | `to_do` |
| 6 | **Scenario suite and bundle oracles** — Add the ten representative scenarios, canned URL-service fixtures, and bundle-local correctness oracles under `examples/bundles/historia-default/`, keeping substrate oracles in `testing/oracles-lib/` untouched. | `to_do` |
| 7 | **Local and Fly proof run** — Run the full `historia-default` scenario suite locally and on Fly, then record all seventeen substrate oracles plus bundle-correctness oracle results for every scenario. | `to_do` |
| 8 | **Phase verification** — Re-read this phase's directive and exit signal in the [README](../README.md). Walk every [`docs-next/`](../../docs-next/) page and code path the phase touches; confirm every subtask above has been enumerated and that the exit signal is actually met. If anything is missing, add rows above this one and rerun. | `to_do` |
