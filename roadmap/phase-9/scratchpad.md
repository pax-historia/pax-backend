# Phase 9 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-29 03:51 PDT

Opened Phase 9 after Phase 8 completed locally. The directive is to
re-bootstrap the three Fly apps on the new Broker/Runner shard image, with no
per-shard RocksDB volume, then prove roughly 100 concurrent games for 30 minutes
under both no-fault and shard-death-every-five-minutes profiles with all
guarantee oracles green and at least one continuous placement-through-URL-service
trace exemplar visible.

First task is a surface audit before touching Fly state: re-read the deploy and
bootstrap scripts, `fly.*.toml`, the observability pipeline, Fly-proxy WebSocket
machine-routing assumptions, and the scenario/scale commands that will produce
the 100-game proof.
