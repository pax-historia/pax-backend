# Phase 5 — Scale climb to v1

> Status: `in_progress` · Directive and exit signal: [README](../README.md)

## Tasks

Each row is a unit of work — big enough to be a task, not an entire major project, and not a single trivial change. Progress is a few sentences max; for anything that grows beyond that, log the detail in [`scratchpad.md`](scratchpad.md) and keep the cell short. The last row is always a phase-verification task — re-read the directive and exit signal, walk the docs the phase touches, and confirm nothing was missed. If something was, add rows above the verification row and rerun.

| # | Task | Progress |
|---|---|---|
| 1 | **Scale surface audit and ladder plan** — Re-read the Phase 5 directive/exit signal plus the scale, scenario-runner, observability, placement, and cost docs. Convert the phase into a concrete rung ladder from 100 to 1000 games, define the required per-rung artifacts, and identify which existing runner gaps block attribution. | `in_progress` — Phase 5 is now active. Initial audit found the target at 1000 games across 10 shard machines, expected runner sampling profiles, and a current gap: attribution is still mostly history-derived and does not yet scrape the live service `/metrics` panels during a rung. |
| 2 | **Scale-rung runner artifacts** — Add a declarative scale ladder plan and runner entry point that executes a selected rung, preserves per-rung `result.json`, history, suite metadata, and writes a machine-readable rung summary. Rungs must carry game count, shard-machine target, runtime, nemesis set, sampling profile, and pass/fail status. | `to_do` |
| 3 | **Metrics collector and attribution closure** — Scrape router, parent, gateway, control-plane, and vendored-engine metric endpoints during live rungs, summarize Prometheus histograms/counters into `ScenarioMetrics`, and make attribution sentences rank observed cliffs against the playbook thresholds. | `to_do` |
| 4 | **Shard scaling controls and placement proof** — Exercise the Fly scaling path from 1 to 10 shard machines, verify capacity rows and placement distribution at each rung, and document the exact commands plus recovery signals. This is infrastructure scaling, not a new tenant abstraction. | `to_do` |
| 5 | **Cost projection through 10k games** — Produce a measured projection from rung artifacts through 10,000 concurrent games, including shard/control/driver machine counts, storage and observability volume assumptions, and the no-billing boundary. | `to_do` |
| 6 | **24-hour v1 soak** — Run the 1000-game, 10-shard target under the full nemesis suite for 24 hours, with `ivm` and `noivm` evidence where the release gate requires both, and preserve every artifact needed to replay or attribute failures. | `to_do` |
| 7 | **Phase verification** — Re-read this phase's directive and exit signal in the [README](../README.md). Walk every [`docs-next/`](../../docs-next/) page and code path the phase touches; confirm every subtask above has been enumerated and that the exit signal is actually met. If anything is missing, add rows above this one and rerun. | `to_do` |
