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

## 2026-05-28 03:52 PDT

Completed the local smoke pass. `scripts/dev/local-up.sh` initially brought the
stack up, but the cached router binary under `.cache/router/router` was stale:
placement responses missed `traceId`, `runtimeContractRequired`, and
`runtimeContractsSupported`, so the parent rejected the placement token as
missing required claims. Rebuilt with `pnpm build:router`, restarted the router,
and confirmed the placement response now carries the current contract fields.

Updated `scripts/dev/local-up.sh` so it rebuilds the cached placement-router
binary when `orchestration/placement-router/src`, `Cargo.toml`, or `Cargo.lock`
is newer than `.cache/router/router`.

Verification: `bash -n scripts/dev/local-up.sh` passes, and `pnpm smoke` ran
green against the local stack with no production `.env`:
`PASS — vertical smoke green in 766ms` with session
`ses_9b48723420f0843372482c8c4ae25942`.

Codex tool note: background processes launched by `local-up.sh` from a
non-interactive tool command were reaped after the command returned, so the
successful smoke run used persistent tool sessions for engine, control plane,
API gateway, parent actor, and router. This appears to be tool-session process
lifetime behavior rather than a substrate runtime issue.

## 2026-05-28 03:55 PDT

Completed the dependency audit pass. `pnpm audit` returned
`No known vulnerabilities found`.

`cargo audit` was not installed on this Mac, so installed `cargo-audit v0.22.1`
with `cargo install cargo-audit --locked` and ran it against
`orchestration/placement-router/Cargo.lock`. The refreshed RustSec database had
1098 advisories, the lockfile had 197 dependencies, and the audit reported
zero vulnerabilities.
