# AGENTS.md — pointers for autonomous work in pax-backend

## Where to look

[`docs-next/`](docs-next/) is the canonical description of what the substrate looks like once shipped. Read it first. If it disagrees with [`README.md`](README.md), `docs-next/` wins.

[`roadmap/README.md`](roadmap/README.md) is the current execution status: one row per phase, three states (`complete`, `in_progress`, `to_do`), one directive and one exit signal each. Look here to find out which phase is active and where to write notes. Per-phase notes live in `roadmap/phase-N/task-tracker.md` (table of tasks with short progress notes per task) and `roadmap/phase-N/scratchpad.md` (timestamped running log of what was done, what worked, what didn't, and design decisions made along the way).

## Standing constraints

These are not optional and not negotiable inside the active phase.

- **No billing primitives.** Pressure to add anything balance-, debit-, reservation-, or refund-shaped is a signal to re-read [`docs-next/why/why-no-billing.md`](docs-next/why/why-no-billing.md) and lean harder on session observability plus the URL-service pattern.
- **No tenant-shaped abstractions.** The substrate is single-consumer by design; multi-tenancy is a design force, not a feature.
- **The teardown allowlist in [`scripts/bootstrap/tear-down.sh`](scripts/bootstrap/tear-down.sh) is hard-coded** to three Fly apps and one Tigris bucket. Do not generalize it. If you feel the urge, stop and report.
- **No edits inside [`vendor/rivet/`](vendor/rivet/).** Upstream changes pull from the `pax-rivet-refactor` sibling repo.
- **Sibling spike repos are read-only references.** Patterns lift; code rewrites in-repo. No reads or writes into `pax-spike-fly`, `pax-sharded-spike`, or `pax-rivet-refactor` from this repo.

## Don't wait around

Long-running work — builds, load tests, deploys, container pulls, scenario runs — runs in the background while you do other useful things in parallel. There is always something productive to do while a process is running: re-read the active phase's `task-tracker.md`, audit the scratchpad for missed to-do items, compare recent code against the desired-state docs to find drift, inspect past log traces or `history.jsonl` in more detail, or pick up the next task. Watching a progress bar is never the best use of time.

The corollary: if a long-running task is going to take more than a few seconds, kick it off in the background and immediately pick up the next piece of work. When the background task finishes (or surfaces a notable signal), come back to it.
