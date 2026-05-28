# Phase 4 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-28 10:18 PDT

Started Phase 4 after closing the historia-default proof. Re-read the directive and exit signal: this phase is not about adding more happy paths; it is about actively trying to break the substrate through compromised bundles, race conditions, stolen JWTs, compute-budget edges, partition nemeses, and rolling-deploy collisions. The exit signal is a CI release gate: full scenario suite, every nemesis profile, both `ivm` and `noivm`.

Current inventory before new work: `testing/scenarios/` has `chat-steady-state`, `compute-stress`, and `shard-death-resilience`; `examples/bundles/historia-default/scenarios/` has the ten proof scenarios from Phase 3; `testing/nemeses/` has `no-faults` and `shard-death-every-5m`; CI has smoke/type/deploy workflows but no full scenario-suite release gate. The runner already supports live workloads, scenario-local oracles, delayed Fly history waits, archived history filtering, and nemesis scheduling for `kill-shard`, but it does not yet expose a full catalog x nemesis x runtime matrix as a single release-gate command.

Task split for this phase: first build the runtime/suite matrix foundation, then add adversarial scenarios for compromised bundles/JWTs, compute-budget edges, race/partition/deploy collisions, wire CI as the gate, and finally verify all docs/code touched by the phase.
