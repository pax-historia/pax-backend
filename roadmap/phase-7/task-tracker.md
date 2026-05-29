# Phase 7 — Runtime rewrite (code only)

> Status: `in_progress` · Directive and exit signal: [README](../README.md)

## Tasks

Each row is a unit of work — big enough to be a task, not an entire major project, and not a single trivial change. Progress is a few sentences max; for anything that grows beyond that, log the detail in [`scratchpad.md`](scratchpad.md) and keep the cell short. The last row is always a phase-verification task — re-read the directive and exit signal, walk the docs the phase touches, and confirm nothing was missed. If something was, add rows above the verification row and rerun.

| # | Task | Progress |
|---|---|---|
| 1 | **Surface audit** — Re-read this phase's directive/exit signal and the [`docs-next/`](../../docs-next/) pages and code surfaces it touches (`runtime/`, `shared/ipc-protocol`, `sdk/`, `orchestration/`, `testing/oracles-lib`, `examples/bundles/historia-default`, `fly.shards.toml`, `vendor/rivet`). Expand this placeholder into a concrete task list. | `complete` — Audit found the expected old-runtime residue: Rivet shard image/scripts/env, `parent-actor`, per-game child runners, Rivet WS protocols, `applySyncPromise`, Rivet-shaped shard rows, and scenario-runner/observability assumptions. |
| 2 | **Workspace/runtime package reshape** — Replace the old runtime package topology with production-shaped Broker, Runner, and state-store packages. Update workspace/package references while preserving the no-ivm conformance runtime. | `to_do` |
| 3 | **Async Broker/Runner IPC contract** — Rewrite `shared/ipc-protocol` around request-id async messages, Broker-stamped identity, assignment validation, Runner telemetry, and state/blob/ws/api/lifecycle channels. Remove any contract path that assumes synchronous isolate calls. | `to_do` |
| 4 | **Credential-holding Broker core** — Implement the per-shard Broker: WS termination/JWT verification, session lifecycle, allowed-player checks, idempotent input, budget enforcement, history writes, capacity watermarks, Runner-pool supervision, gateway/Redis/Tigris egress, and admin/health/metrics surfaces. | `to_do` |
| 5 | **One-state-object state store** — Implement the Broker-owned state cache and checkpoint engine: root object format, write-back cache, conditional root PUT fencing, blob manifest, checkpoint scheduler, GC hooks, and time-travel view/restore scaffolding. | `to_do` |
| 6 | **Credential-less Runner pool** — Implement ivm and no-ivm Runners that host many games per process, expose a frozen async `c.*` shim, enforce handler CPU timeout and isolate memory caps, emit per-isolate telemetry, and hold no credentials/network/fs access. | `to_do` |
| 7 | **Router/control/gateway integration** — Update placement-router, control-plane, gateway, host-event wake, drain/redeploy, and Redis shard rows to the Broker/Runner model: no Rivet actor fields, no guard/tunnel routing, and Fly-proxy machine-pinned WS URLs. | `to_do` |
| 8 | **Dev/Fly packaging and observability** — Replace the Rivet shard image/local-up path with Broker+Runner startup, remove engine build/vendor steps from runtime images, update Fly env/TOML, and rename metrics/vector surfaces from parent/Rivet to Broker/Runner. | `to_do` |
| 9 | **Tests, scenarios, and historia compatibility** — Update smoke bot, scenario-runner live WS client, scale metrics, oracles, and `historia-default` expectations for the new transport/state model and new-invariant coverage. | `to_do` |
| 10 | **Phase verification** — Re-read this phase's directive and exit signal in the [README](../README.md). Walk every `docs-next/` page and code path the phase touches; confirm each maps to production-shaped code, every package typechecks, and no `applySyncPromise` / Rivet runtime dependency / process-per-game model remains. If anything is missing, add rows above this one and rerun. | `to_do` |
