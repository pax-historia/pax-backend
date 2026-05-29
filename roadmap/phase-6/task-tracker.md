# Phase 6 — Pause and pivot

> Status: `complete` · Directive and exit signal: [README](../README.md)

## Tasks

Each row is a unit of work — big enough to be a task, not an entire major project, and not a single trivial change. Progress is a few sentences max; for anything that grows beyond that, log the detail in [`scratchpad.md`](scratchpad.md) and keep the cell short. The last row is always a phase-verification task — re-read the directive and exit signal, walk the docs the phase touches, and confirm nothing was missed. If something was, add rows above the verification row and rerun.

| # | Task | Progress |
|---|---|---|
| 1 | **Surface audit** — Re-read this phase's directive/exit signal and the surfaces it touches (the running Phase 5 soak, `scripts/fly/*`, the Fly apps, this roadmap). Expand this placeholder into a concrete task list that can close the exit signal. | `complete` — Phase 6 has three concrete closure surfaces: stop and archive the in-flight validation, stop the old Fly runtime compute, and land the roadmap/phase scaffolding for the Broker/Runner arc. |
| 2 | **Stop and archive Phase 5 validation** — Stop the detached v1-scale validation after preserving the clean no-fault result and partial shard-death ramp artifacts locally. | `complete` — Stopped the validation processes on driver machine `1854539b257768`, pulled `/data/phase-5/validation/ivm-v1scale-20260529T063808Z`, and summarized it locally with `validation-summary.stopped.json`. |
| 3 | **Zero old runtime compute** — Stop the old Rivet-backed Fly runtime machines without destroying apps, volumes, buckets, Redis, or Infisical state. | `complete` — All machines in `pax-backend-shards`, `pax-backend-control`, and `pax-backend-driver` report `stopped`. The teardown allowlist was not generalized. |
| 4 | **Phase verification** — Re-read this phase's directive and exit signal in the [README](../README.md). Confirm the soak is stopped with evidence archived, the Fly runtime apps cost nothing, and the roadmap reflects the new arc. If anything is missing, add rows above this one and rerun. | `complete` — Exit signal met: Phase 5 is closed as `superseded`, the Phase 6-11 arc exists in the roadmap, the evidence is archived in Phase 5/6 ledgers, and runtime Fly machines are stopped. |
