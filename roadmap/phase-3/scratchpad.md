# Phase 3 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-28 08:44 PDT

Started Phase 3 after re-reading the roadmap directive/exit signal, [`docs-next/proofs/historia-default.md`](../../docs-next/proofs/historia-default.md), and [`examples/bundles/historia-default/README.md`](../../examples/bundles/historia-default/README.md). The five URL service spec files already exist as schema-only docs, but the bundle directory is still README-only and the scenario/oracle suite has not been authored.

Initial work split: audit the URL-service fixture contracts first, then land the bundle scaffold/build shape, then port core state/blob/migration code, modules/workflows, routing/hydration/policy gates, scenarios/oracles, and finally the local/Fly proof run. Keep Pax-historia-specific logic contained under `examples/bundles/historia-default/` and the schema-only URL-service examples; substrate zones stay generic.
