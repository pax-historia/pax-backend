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

## 2026-05-29 02:12 PDT

Started the credential-less Runner pool task with the no-ivm conformance
Runner. `NoIvmRunnerProcess` now hosts many games in one process using one
Node `vm` context per game, installs a frozen async `c.*` object, and forwards
every substrate capability through a `BrokerBridge` instead of holding any
credential or network/storage adapter directly. It emits `isolate.ready`,
handler complete/error events, console/log/metrics/lifecycle events, and Runner
telemetry after handler execution.

This no-ivm implementation is not a security boundary, but it is the contract
drift detector for the same async bridge the isolated-vm Runner will use. The
next slice is the production isolated-vm Runner and then the process-level IPC
wrapper.

## 2026-05-29 02:14 PDT

Added the isolated-vm Runner implementation. `IvmRunnerProcess` now hosts many
games as one isolate per game, evaluates bundles inside isolated-vm, injects a
deep-frozen async `c.*` shim, uses promise-returning bridge calls instead of
`applySyncPromise`, wraps handlers with isolated-vm timeouts, sets per-isolate
memory limits from the assignment, and emits handler plus isolate counter
telemetry back through the Broker bridge.

The Runner still needs a child-process wrapper so a real Broker process can
talk to Runner processes over the shared request-id IPC envelope rather than an
in-process `BrokerBridge`.

## 2026-05-29 02:25 PDT

Closed the credential-less Runner pool task by adding the process-level IPC
wrapper. `ChildProcessRunnerProcess` now gives the Broker a normal
`RunnerProcess` facade over a forked worker, sends assign/release/handler
envelopes to the child, correlates assign and invoke completion through
request IDs, and forwards every Runner-to-Broker envelope back to the Broker's
handler.

The child host starts either an isolated-vm or no-ivm multi-game Runner, emits
`runner.ready`, resolves Broker responses for async `c.*` calls, and attaches
the parent request ID to `isolate.ready` and handler complete/error responses
without giving the Runner direct credentials, network, storage, or filesystem
adapters. A small bridge-envelope timeout metadata field now carries the
Broker-selected handler deadline across process IPC without changing bundle
payloads.

## 2026-05-29 02:33 PDT

Started the router/control integration task by replacing the placement
router's old Rivet URL construction path. The router now accepts
`POST /placement`, reads Broker-style shard rows, filters by health,
accepting-wakes, freshness, capacity, and runtime contract range, prefers an
eligible active-game shard, claims/refreshed `active_games:<gameId>` with a
generation token, signs Broker-readable JWT claims with `playerId`, and returns
direct Broker websocket URLs with Fly machine pin hints from `broker.flyMachineId`.
The legacy `GET /games/:id/placement` path remains as a compatibility shim for
callers that have not moved yet.

The Broker Redis directory now publishes `broker.wsPath` plus
`broker.flyMachineId` from `FLY_MACHINE_ID`, and the control-plane
host-event wake trigger calls the new `POST /placement` shape without Rivet
subprotocols. This does not finish host-event delivery yet; the next slice
needs to connect queued host events to the active Broker and tighten the
Broker/control admin wake/drain path.

## 2026-05-29 02:36 PDT

Connected the host-event queue to the Broker model. The Broker dependency
surface now accepts a host-event queue adapter, wakes a game through the same
bundle resolver path when asked to drain host events, drains Redis
`host_events:<gameId>` records, invokes the bundle's `onHostEvent` handler for
each record, and writes `onHostEvent.delivered` history. The Broker admin
surface exposes `POST /admin/games/:id/host-events/drain` for the control plane.

The control plane now queues both active and wake-on-delivery host events, uses
the active shard row or a fresh `POST /placement` response to find the Broker,
and asks that Broker to drain the queue. This removes the synthetic WebSocket
wake path and the old Rivet subprotocols from control-plane host-event wake.

## 2026-05-29 02:38 PDT

Wired shard drain and un-drain to Broker admin instead of treating drain as
only a Redis flag. The Broker now exposes `DELETE /admin/drain` to resume wake
acceptance after an operator clears drain, and the control plane calls
`POST /admin/drain` / `DELETE /admin/drain` on the shard's Broker URL when its
admin drain endpoints mutate the shard drain flag. Shard views now prefer
`currentGameCount` when present so Broker capacity rows and drain-completion
logic report the same count.

## 2026-05-29 02:39 PDT

Closed the router/control/gateway integration task with a schema cleanup pass.
The primary `ShardRegistration` and `ActiveGamePlacement` protocol rows no
longer carry optional Rivet routing or actor fields; the legacy parent-actor
keeps its old Rivet registration extension locally so it can continue to
typecheck until the packaging task removes it from the shipped runtime path.

The active Phase 7 router/control/Broker/Gateway surfaces now use Broker shard
rows, Broker admin drain/host-event delivery, active-game generation claims,
and Broker-readable JWT claims. Remaining old-runtime references found by
audit are in scenario-runner/oracle/metrics compatibility areas that belong to
the later tests/scenarios task, plus the old parent-actor package that belongs
to the packaging removal task.

## 2026-05-29 02:43 PDT

Started the dev/Fly packaging task by adding a Broker-native shard runtime
entrypoint. `runtime/broker/src/server.mts` now composes Redis-backed
directory/allowed-player/host-event/bundle adapters, local or S3/Tigris state
storage, JSONL history, the API gateway client, a child-process Runner pool,
Broker admin routes, and Broker WebSocket upgrades on one HTTP server.

The shard Dockerfile no longer has a Rust `rivet-engine` build stage or vendor
TypeScript build step. It builds the shared protocol, runtime SDK, state-store,
Runner, Broker, and bundles, then the shard image entrypoint starts Vector plus
the Broker server directly. The next packaging slice is to move the local dev
scripts and Fly env/TOML off parent/Rivet naming.

## 2026-05-29 02:45 PDT

Moved the local dev stack onto Broker/Runner. `scripts/dev/local-up.sh` now
starts Redis, control-plane, API gateway, the Broker runtime server with a
child-process Runner pool, and the placement router. It no longer checks for,
builds, or starts `rivet-engine`, vendor Rivet TypeScript, or `parent-actor`.
`local-down.sh` now stops Broker and Runner child processes instead of the old
engine/parent processes. Both scripts pass `bash -n`.

## 2026-05-29 02:48 PDT

Closed the dev/Fly packaging and observability task. `fly.shards.toml` now
routes the shard service to Broker port 7700 and uses Broker/Runner env names
instead of Rivet guard/engine/parent settings. Vector production, shard, and
local profiles scrape `PAX_BROKER_METRICS_URL` and no longer scrape parent or
Rivet metrics, with gateway/control defaults aligned to the actual local ports.

The stale local `scripts/dev/spawn-engine.mts` helper is removed, and an audit
over `fly.shards.toml`, `runtime/shard-image`, `scripts/dev`, and
`scripts/observability` found no remaining Rivet/parent runtime references
except the word "parents" in a process-sweep safety comment.

## 2026-05-29 03:02 PDT

Closed the tests/scenarios compatibility task. The smoke bot and live
scenario executor now call the router's `POST /placement` endpoint and open
Broker WebSockets directly, with JWT wrong-game tests mutating the `gameId`
query parameter instead of Rivet subprotocol state. Scenario metrics now scrape
Broker endpoints through `PAX_BROKER_METRICS_URL(S)`.

The Broker history surface now emits Broker/Runner-era lifecycle, session,
storage, blob, WS, player, compute, and API request/response events with the
fields the oracles need. The oracles and scenario-local checks were updated
from parent/child event names to Broker/Runner names while preserving legacy
replay compatibility where it is cheap. `pnpm typecheck`, `bash -n
scripts/test/scenario-suite-local.sh`, and `git diff --check` pass.

## 2026-05-29 03:08 PDT

The Phase 7 verification pass found the old Rivet parent/per-game child
packages still wired into the root workspace and typecheck graph, plus stale
Rivet build helpers and Fly scaling volume/env logic. Added a cleanup task
above final verification and closed it.

The active workspace now contains Broker, Runner, and state-store runtime
packages only. Removed the tracked old parent/child package files, root
references to them, Rivet package overrides, and obsolete `build:engine` /
`build:vendor-ts` helpers. Fly shard scaling and bootstrap no longer provision
or normalize the old RocksDB volume/Rivet env path; shard machines normalize
Broker port 7700 and `PAX_RUNNER_KIND`.

## 2026-05-29 03:10 PDT

Closed Phase 7 verification. Re-read the directive and exit signal, walked the
docs-next architecture surfaces against active code paths, and reran the
forbidden-residue scan over active runtime/build/test paths. The only remaining
mentions of Rivet/process-per-game/applySyncPromise are historical rationale or
anti-examples inside `docs-next/why` and `docs-next/subsystems/runner.md`, not
active runtime code.

Verification commands passed: `pnpm typecheck`, `cargo check --manifest-path
orchestration/placement-router/Cargo.toml`, `bash -n` over changed dev/test/Fly
scripts, and `git diff --check`. Marked Phase 7 `complete` and opened Phase 8
as `in_progress`.
