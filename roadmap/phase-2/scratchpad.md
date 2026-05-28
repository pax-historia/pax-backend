# Phase 2 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-28 03:56 PDT

Activated Phase 2 after Phase 1 closed green. The phase target is the Fly
topology proof: three apps (`pax-backend-shards`, `pax-backend-control`,
`pax-backend-driver`) backed by Tigris bucket `pax-backend-blobs` and Upstash
Redis `pax-backend-directory`, then 100 concurrent hello-world games for 30
minutes under both no-fault and shard-death-every-five-minutes profiles.

Re-read `AGENTS.md` before moving into this phase. The teardown allowlist in
`scripts/bootstrap/tear-down.sh` remains hard-coded to the three Fly apps and
one Tigris bucket; do not generalize it while working on the bootstrap or
deployment path. Commit cadence is around once per task unless a smaller
checkpoint is clearly warranted.
