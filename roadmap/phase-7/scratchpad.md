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

## 2026-05-29 01:51 PDT

Reworked `@pax-backend/ipc-protocol` around the new Broker/Runner bridge
described in `docs-next/reference/ipc-protocol.md`. The primary exports are now
`BridgeEnvelope`, `BrokerToRunnerEnvelope`, `RunnerToBrokerEnvelope`,
`BROKER_TO_RUNNER`, and `RUNNER_TO_BROKER`, with request IDs on async
request/response channels and `gameId` on game-scoped messages so the Broker can
enforce Runner assignment.

The package also now carries assignment grants, `assign`/`release`, Runner
readiness, isolate readiness, handler telemetry, isolate counters, fatal-error
payloads, and the state/blob/ws/api/lifecycle channels as one contract. The old
`ParentToChildEnvelope`/`ChildToParentEnvelope` names remain as temporary
compatibility aliases so the pre-Broker runtime packages keep typechecking while
their dedicated Phase 7 tasks replace the implementation. A few gateway and URL
service call sites were adjusted for docs-next's `runId: null` production shape.

## 2026-05-29 02:00 PDT

Started the credential-holding Broker core. The Broker package now has a real
stateful shard owner instead of a package-boundary stub: JWT placement-token
verification, allowed-player checks, websocket session records, ready frames,
player-message sequencing, sleep-grace release, Runner assignment validation,
and request dispatch for `state.*`, `blob.*`, `ws.send`, `players.*`,
`compute.budget`, `api.invoke`, logs, metrics, lifecycle, handler telemetry,
and isolate counters.

Budget enforcement is still deliberately simple but production-shaped: sliding
windows for websocket bytes/messages and API invokes, state/blob size and key
counts, and per-isolate CPU/memory samples from Runner telemetry. The Broker
now writes capacity rows and history events for these paths and checkpoints via
the state-store session before release. This does not yet start a server or
wire real child process IPC; those belong to the remaining Broker, Runner, and
packaging tasks.

## 2026-05-29 02:02 PDT

Added the Broker's operator-facing control surfaces. The Broker can now enter
drain mode, evict one game, snapshot health/readiness, and render Prometheus
text for active games, connected sessions, wake acceptance, capacity, and max
budget-consumed ratio by budget. The package also exports a small admin HTTP
server factory with `/healthz`, `/readyz`, `/metrics`, `POST /admin/drain`, and
`POST /admin/games/:id/evict`.

These routes are not wired into a shard image yet; the point of this slice is
to make the Broker core's operational surface concrete before the later
packaging task decides bind addresses, auth, and Fly process layout.

## 2026-05-29 02:04 PDT

Closed the Broker-core task by adding the production adapter layer around the
core class. Redis adapters now publish shard capacity rows, claim/release active
games, and read allowed-player sets. The gateway adapter posts to the API
gateway invoke endpoint, the JSONL history writer adds per-shard `pax_seq`, and
the bundle resolver reads game/bundle metadata from Redis and bundle source from
either inline records, a local object root, or an S3-compatible Tigris store.

The remaining process-level IPC implementation is intentionally left for the
Runner-pool task; Broker task 4 now has the credential-holding authority,
egress adapters, and operational surfaces the later Runner and packaging work
can plug into.

## 2026-05-29 02:10 PDT

Completed the one-state-object state-store task. The package now implements the
Broker-owned read-through/write-back cache as `GameStateSession`, with dirty
state and dirty blob manifests committed together through one conditional head
root PUT. State can be inlined in the root or written as a content-addressed
state object; blob keys write immutable content-addressed versions referenced by
the root manifest.

History mechanics are now present: retained immutable root objects, parent
chains, checkpoint listing, read-only checkpoint view, and revert-forward
restore that writes a new head root referencing an older snapshot. GC is
production-shaped for both modes: no-history sessions delete superseded object
versions after the head commits, retained-history sessions prune beyond the
configured horizon, and an orphan reaper can sweep unreferenced objects when the
underlying store supports listing. The package also has memory, local-file, and
S3/Tigris-compatible `StateObjectStore` adapters with conditional put conflict
surface.
