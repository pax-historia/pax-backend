# Phase 5 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-28 11:35 PDT

Started Phase 5. Re-read the roadmap directive and the relevant desired-state docs for scale: `docs-next/vision/substrate-overview.md`, `docs-next/subsystems/scenario-runner.md`, and `docs-next/subsystems/observability.md`. The target is explicit: 1000 concurrent games across 10 Rivet shard machines, with the runner narrating every cliff through per-surface metrics and attribution sentences.

Initial code audit shows the Phase 4 suite gate is in place, but Phase 5 still needs a real scale ladder path. The runner can emit `sampling_profile` and has a history-derived attribution helper, yet it does not currently scrape live `/metrics` endpoints during a rung or emit a rung-level artifact that ties game count, shard count, nemesis profile, sampling profile, and cost inputs together. First implementation work should close that artifact/measurement gap before attempting longer Fly soaks.

## 2026-05-28 11:49 PDT

Added the first Phase 5 scale-ladder implementation. The declarative plan lives at `testing/scale-ladders/v1-scale.mts` with rungs at 100/250/500/750/1000 games and 1/3/5/8/10 shard-machine targets. The runner has a new `--scale-plan` mode that can execute one or more selected rungs, emits `scale-ladder.result.json` plus one `rung.result.json` per rung, and stores the per-case scenario `result.json` and history paths under the rung output directory.

The scale runner reuses normal scenario execution rather than creating a separate driver path. It applies rung targets by overriding the loaded workload's `maxGames`, `durationMs`, `open-sessions` ramp/session count, and `send-json` message count derived from target duration. That keeps the scale path tied to the same manifest/oracle/runtime machinery as the Phase 4 release gate.

Verification so far: `pnpm --filter @pax-backend/scenario-runner check-types`, `git diff --check`, and a replay-mode scale smoke for `100g-1shard`. The replay smoke intentionally exited through the oracle-failure code on empty history, then verified the artifact shape: one ladder result, one rung result, two nemesis cases, `max_games: 100`, and `send-json.messagesPerSession: 1800`.
