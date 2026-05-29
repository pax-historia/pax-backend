# Phase 8 — Local build + smoke

> Status: `in_progress` · Directive and exit signal: [README](../README.md)

## Tasks

Each row is a unit of work — big enough to be a task, not an entire major project, and not a single trivial change. Progress is a few sentences max; for anything that grows beyond that, log the detail in [`scratchpad.md`](scratchpad.md) and keep the cell short. The last row is always a phase-verification task — re-read the directive and exit signal, walk the docs the phase touches, and confirm nothing was missed. If something was, add rows above the verification row and rerun.

| # | Task | Progress |
|---|---|---|
| 1 | **Surface audit** — Re-read this phase's directive/exit signal and the local build/smoke surfaces (`scripts/dev/*`, `testing/smoke-bot`, the smoke target, the build matrix). Expand this placeholder into a concrete task list. | `complete` — Audit identified the concrete Phase 8 loop: run the active package build matrix after the legacy runtime removal, rebuild router and creator bundles, bring up the local Broker/Runner stack, run `pnpm smoke`, then run `pnpm audit` and `cargo audit` or log any missing audit tool. |
| 2 | **Build matrix** — Run the local build matrix for active packages plus router and creator bundle artifacts; fix any compile/build break surfaced by the Phase 7 rewrite. | `complete` — `pnpm -r --if-present run build` completed across the active workspace, `scripts/build/build-router.sh` rebuilt the release router into `.cache/router/router`, and `scripts/build/build-bundles.sh` rebuilt all creator bundles. No source changes were needed. |
| 3 | **Local Broker smoke** — Start the local stack with no production `.env`, run `pnpm smoke`, and fix runtime bugs until the Broker/Runner path opens a session, echoes over WS, writes checkpoint/history, and shuts down cleanly. | `complete` — Local stack came up through `scripts/dev/local-up.sh`, and `pnpm smoke` now passes against the Broker/Runner path. Fixes covered shard registry heartbeats, active-game generation reuse, bundle-defined outbound WS frames, single-recipient `ws.send` history identity, and `log.emit` history wrapping. |
| 4 | **Dependency audit** — Run `pnpm audit` and `cargo audit` if available. Fix cleanly actionable findings; otherwise log each residual finding with rationale. | `to_do` |
| 5 | **Phase verification** — Re-read this phase's directive and exit signal in the [README](../README.md). Confirm `pnpm smoke` is green on this Mac on the new runtime with no production `.env` and audits are clean or logged. If anything is missing, add rows above this one and rerun. | `to_do` |
