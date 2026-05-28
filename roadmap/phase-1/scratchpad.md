# Phase 1 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-28 03:46 PDT

Started Phase 1 after Phase 0 verification completed. Per `AGENTS.md`, commit
cadence is now around once per task unless there is a concrete reason to split
or batch differently.

Initial root `pnpm typecheck` result: one failure in
`examples/url-services/billing-mock.v1/src/index.mts`, where the existing
refund record passed to the ledger is missing the required `eventId` field.
Because this is a billing-shaped example outside the substrate, re-read
`docs-next/why/why-no-billing.md` before touching it.

Fixed the typecheck blocker by introducing an internal `RefundEventAction`
shape for the example URL service's generated refund event. This keeps the
parsed refund request (`eventId` points at the original charge) separate from
the ledger event (`relatedEventId` points at that charge while a new event id
is generated). No substrate billing contract was added or changed.

Verification: `pnpm --filter @pax-backend/example-url-service-billing-mock-v1
check-types` and root `pnpm typecheck` both pass.
