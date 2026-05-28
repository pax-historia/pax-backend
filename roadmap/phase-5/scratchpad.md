# Phase 5 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-28 11:35 PDT

Started Phase 5. Re-read the roadmap directive and the relevant desired-state docs for scale: `docs-next/vision/substrate-overview.md`, `docs-next/subsystems/scenario-runner.md`, and `docs-next/subsystems/observability.md`. The target is explicit: 1000 concurrent games across 10 Rivet shard machines, with the runner narrating every cliff through per-surface metrics and attribution sentences.

Initial code audit shows the Phase 4 suite gate is in place, but Phase 5 still needs a real scale ladder path. The runner can emit `sampling_profile` and has a history-derived attribution helper, yet it does not currently scrape live `/metrics` endpoints during a rung or emit a rung-level artifact that ties game count, shard count, nemesis profile, sampling profile, and cost inputs together. First implementation work should close that artifact/measurement gap before attempting longer Fly soaks.
