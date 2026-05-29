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
