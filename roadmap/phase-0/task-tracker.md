# Phase 0 — Scaffold completion

> Status: `in_progress` · Directive and exit signal: [README](../README.md)

## Tasks

Each row is a unit of work — big enough to be a task, not an entire major project, and not a single trivial change. Progress is a few sentences max; for anything that grows beyond that, log the detail in [`scratchpad.md`](scratchpad.md) and keep the cell short. The last row is always a phase-verification task — re-read the directive and exit signal, walk the docs the phase touches, and confirm nothing was missed. If something was, add rows above the verification row and rerun.

| # | Task | Progress |
|---|---|---|
| 1 | **Tigris-canonical `c.state`** — Replace the Redis-backed branch in [`runtime/parent-actor/src/parent.mts`](../../runtime/parent-actor/src/parent.mts) with CBOR-to-Tigris flush plus an in-process cache and flush window. See [`docs-next/contract/storage.md`](../../docs-next/contract/storage.md). | `to_do` |
| 2 | **Tigris-canonical `c.blob`** — Per-game namespace at `blob/<gameId>/<key>` in Tigris with per-key and per-namespace byte/key budgets enforced at the parent. | `to_do` |
| 3 | **Tigris bundle upload pipeline** — Replace the Redis-only bundle manifest in [`orchestration/control-plane/src/store.mts`](../../orchestration/control-plane/src/store.mts) with PUT-to-Tigris + sha256 verification, per [`docs-next/subsystems/bundle-storage.md`](../../docs-next/subsystems/bundle-storage.md). | `to_do` |
| 4 | **Shard-side bundle cache** — Pull-on-cold-wake from Tigris with a local cache bounded by working set. | `to_do` |
| 5 | **Shard image Dockerfile** — Multi-stage build at [`runtime/shard-image/`](../../runtime/shard-image/) bundling Rivet engine + parent + both child runners + IPC schema. | `to_do` |
| 6 | **Scenario-runner workload phase executor** — Implement the declarative phases (`open-sessions`, `send-json`, `expect-history-events`, `register-api-kinds`, `close-sessions`, `wait`) from [`docs-next/subsystems/scenario-runner.md`](../../docs-next/subsystems/scenario-runner.md). | `to_do` |
| 7 | **Scenario-runner live oracle gate** — Run all seventeen guarantee oracles against the live run's history and emit `result.json` with pass/fail per oracle. | `to_do` |
| 8 | **Nemesis runtime injector** — Turn the two existing nemesis config files into scheduled admin-REST actions driven by the runner. | `to_do` |
| 9 | **Host-event admin endpoint** — `POST /admin/games/:id/host-event` in the control plane with `wakeOnDelivery: true` handling. | `to_do` |
| 10 | **Host-event wake path** — Route a control-plane host-event for a sleeping game through the placement router. | `to_do` |
| 11 | **`onHostEvent` IPC + parent + child** — Channel in [`shared/ipc-protocol`](../../shared/ipc-protocol/), parent dispatch, child handler invocation, `onHostEvent.delivered` history event. | `to_do` |
| 12 | **Guarantee #17 oracle** — `testing/oracles-lib/src/guarantees/host-event-durability.mts`. | `to_do` |
| 13 | **Drain ACK closure** — Parent reports drained, control plane emits `shard.drain.completed`, `GET /admin/shards/:id` reflects state. See [`docs-next/subsystems/redeploy-and-drain.md`](../../docs-next/subsystems/redeploy-and-drain.md). | `to_do` |
| 14 | **Vector sidecar configs** — `scripts/observability/vector-prod.toml` and `vector-local-dev.toml` with the cardinality firewall transforms. | `to_do` |
| 15 | **OTel SDK wiring (Node)** — `@opentelemetry/sdk-node` in parent, control plane, gateway, reference URL services. | `to_do` |
| 16 | **OTel SDK wiring (Rust)** — `tracing-opentelemetry` in the placement router. | `to_do` |
| 17 | **Engine OTel pass-through** — `RIVET_OTEL_ENABLED=1` on the vendored engine; confirm spans flow with parent context. | `to_do` |
| 18 | **SDK module split** — Break the single-file [`sdk/runtime-sdk/src/index.mts`](../../sdk/runtime-sdk/src/index.mts) into per-contract modules (`manifest.ts`, `lifecycle.ts`, `storage.ts`, `compute-budgets.ts`, `external-api-channel.ts`). | `to_do` |
| 19 | **`bundle publish` CLI** — Add to [`sdk/bundle-tools/`](../../sdk/bundle-tools/) a command that `POST`s to `/admin/bundles/:bundleName` against a running control plane. | `to_do` |
| 20 | **Reference URL service hardening** — Verify `echo.v1`, `delay.v1`, `http.fetch.v1`, `mock-ai.v1` all set `X-Gateway-Envelope-Version: 2` and that the `http.fetch.v1` allowlist is enforced. | `to_do` |
| 21 | **Phase verification** — Re-read this phase's directive and exit signal in the [README](../README.md). Walk every [`docs-next/`](../../docs-next/) page and code path the phase touches; confirm every subtask above has been enumerated and that the exit signal is actually met. If anything is missing, add rows above this one and rerun. | `to_do` |
