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

The audit found the old runtime assumptions spread across the expected
surfaces: `runtime/parent-actor`, `runtime/child-runner-*`, `runtime/shard-image`,
`shared/ipc-protocol`, `orchestration/placement-router`, control-plane host-event
helpers, scenario-runner and smoke-bot Rivet subprotocols, Fly TOML/env, Vector
metric sources, local dev scripts, and vendor build scripts. The next work is
not a small rename: the code needs a production-shaped Broker, Runner pool,
async IPC contract, and state-store path before Phase 7 can typecheck against
the new `docs-next/` target.

## 2026-05-29 01:44 PDT

Added the new workspace package shape for the Phase 7 runtime rewrite:
`@pax-backend/broker`, `@pax-backend/runner`, and
`@pax-backend/state-store`. This is intentionally a narrow topology commit:
it creates the production-shaped module boundaries and root project references
without yet wiring the old runtime path through them.

The state-store package starts with a root-object API, inline whole-state
encoding, blob manifest versioning, conditional root writes, and an
`enableTimeTravel` parent pointer hook. The Runner package defines assignment,
invoke, release, telemetry, and pool contracts. The Broker package owns the
capacity row shape and the first shard lifecycle/wake boundary. Follow-up tasks
will replace the skeletal contracts with the async IPC protocol, actual Broker
session handling, and Runner implementations.
