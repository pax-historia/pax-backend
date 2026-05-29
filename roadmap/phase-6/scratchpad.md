# Phase 6 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-29 01:31 PDT

Started and closed Phase 6 after the roadmap pivot to Broker/Runner and
one-state-object storage. Re-read the updated Phase 6 directive: stop the
in-flight Phase 5 validation, archive the evidence, stop old runtime compute,
and make the roadmap read as the Phase 6-11 rebuild arc.

Stopped the detached validation at
`/data/phase-5/validation/ivm-v1scale-20260529T063808Z` after the one-hour
no-fault case had passed and the shard-death case was ramping. The preserved
local artifact is
`var/phase-5/validation/ivm-v1scale-20260529T063808Z/validation-summary.stopped.json`:
no-fault passed with 1000 placements, all 10 placement shards, all selected
scenario oracles green, 1000 normal closes, no error events, and bounded
history at 126,012 events / 43,365,629 bytes. The partial shard-death case had
784 placements across all 10 shards with no failures, session errors, capacity
warnings, or budget rejects when stopped.

Stopped the old Fly runtime compute after pulling artifacts. Final inventory:
all 10 `pax-backend-shards` machines stopped; both `pax-backend-control`
machines stopped; both `pax-backend-driver` machines stopped. No apps, volumes,
buckets, Redis instances, or Infisical secrets were destroyed, and the hard-coded
teardown allowlist was not changed.
