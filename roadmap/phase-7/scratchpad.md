# Phase 7 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-29 01:31 PDT

Started Phase 7 after completing the Phase 6 pause-and-pivot. Initial
orientation from the rewritten `docs-next/` target: the runtime path must move
from Rivet / parent actor / per-game child process to a trusted per-shard
Broker, credential-less Runner pool, async `c.*` bridge, and Broker-owned
one-state-object state store. The first task is a surface audit that turns this
new target into concrete code edits before implementation starts.
