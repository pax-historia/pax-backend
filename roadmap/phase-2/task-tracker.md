# Phase 2 — Fly medium-scale proof

> Status: `in_progress` · Directive and exit signal: [README](../README.md)

## Tasks

Each task is a few sentences and a progress field — see [`phase-0/task-tracker.md`](../phase-0/task-tracker.md) for the format. Anything that grows beyond a couple of sentences of progress lives in [`scratchpad.md`](scratchpad.md) instead. The last row is always the phase-verification task below; new tasks get added above it and the verification row gets renumbered to stay last.

| # | Task | Progress |
|---|---|---|
| 1 | **Bootstrap preflight** — Run or dry-run the Fly/Tigris/Upstash bootstrap path as far as credentials allow, preserving the hard-coded teardown allowlist. Verify the three Fly apps, Tigris bucket, Upstash Redis, Infisical sync, shared-secret drift check, and spend-marker behavior are production-shaped. | `complete` — `spin-up.sh` converged idempotently: all three apps, the Tigris bucket, Upstash Redis, and starter shard volume already existed; 21 secret syncs were unchanged, drift verification passed, and the spend marker was preserved. |
| 2 | **Deployable Fly topology** — Build or repair the deployment descriptors and images for `pax-backend-shards`, `pax-backend-control`, and `pax-backend-driver`; deploy them and verify shard, router, control-plane, gateway, driver, Redis, and Tigris health. | `complete` — all three Fly apps deployed; control has 2 started machines with 3/3 checks, driver has 1 active + 1 standby with checks passing, shard has 1 started machine with its check passing. Router, control-plane, gateway, driver, parent, Rivet metrics, Redis, and Tigris health checks passed. |
| 3 | **Observability trace path** — Bring the Vector/OTel pipeline online for the Fly topology, confirm history archiving and metrics scraping, and capture at least one placement-to-URL-service trace exemplar in the configured sink. | `in_progress` — Vector is deployed in all three images. The supplied Better Stack token is synced but Better Stack reports it is not a valid telemetry source token, so Fly is temporarily using the Tigris-backed buffer profile while the trace archive path is verified. |
| 4 | **No-fault medium run** — Run the hello-world workload on Fly at roughly 100 concurrent games for 30 minutes with the no-fault profile, then verify all 17 guarantee oracles are green and record the run artifacts. | `to_do` |
| 5 | **Shard-death medium run** — Run the same 100-game, 30-minute proof with the shard-death-every-five-minutes profile, verify all 17 guarantee oracles are green, and record the recovery evidence. | `to_do` |
| 6 | **Phase verification** — Re-read this phase's directive and exit signal in the [README](../README.md). Walk every [`docs-next/`](../../docs-next/) page and code path the phase touches; confirm every subtask above has been enumerated and that the exit signal is actually met. If anything is missing, add rows above this one and rerun. | `to_do` |
