# Phase 1 — Local Mac build + smoke

> Status: `in_progress` · Directive and exit signal: [README](../README.md)

## Tasks

Each task is a few sentences and a progress field — see [`phase-0/task-tracker.md`](../phase-0/task-tracker.md) for the format. Anything that grows beyond a couple of sentences of progress lives in [`scratchpad.md`](scratchpad.md) instead. The last row is always the phase-verification task below; new tasks get added above it and the verification row gets renumbered to stay last.

| # | Task | Progress |
|---|---|---|
| 1 | **Root TypeScript build** — Run `pnpm typecheck`, fix every compilation error that is safe under the standing constraints, and log any deliberate deferral. | `complete` — Fixed the example billing-mock refund event typing without adding substrate billing surface; `pnpm typecheck` now passes at the repo root. |
| 2 | **Local smoke command** — Run `pnpm smoke` on this Mac with no production `.env`; fix local toolchain/runtime failures until green. | `to_do` |
| 3 | **Dependency audit** — Run `pnpm audit` and `cargo audit`; apply small safe upgrades and log any remaining finding with rationale. | `to_do` |
| 4 | **Phase verification** — Re-read this phase's directive and exit signal in the [README](../README.md). Walk every [`docs-next/`](../../docs-next/) page and code path the phase touches; confirm every subtask above has been enumerated and that the exit signal is actually met. If anything is missing, add rows above this one and rerun. | `to_do` |
