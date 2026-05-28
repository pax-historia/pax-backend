# `testing/nemeses/`

Fault profiles, composed at scenario run time. Orthogonal to scenarios —
any nemesis can wrap any scenario. See [`../README.md`](../README.md) for
the broader rules about the `testing/` zone.

| Nemesis | What it does |
|---|---|
| `no-faults/` | The control. Same scenario, no injection. Reference for the others. |
| `shard-death-every-5m/` | Kills a random shard every 5 minutes. Used with `shard-death-resilience` (and as a soak overlay on the other scenarios). |

The scenario-runner now executes these manifests during live runs. `no-faults`
is a no-op. `shard-death-every-5m` schedules `kill-shard` injections, selects
eligible shards from `GET /admin/shards`, and maps the current Phase 0 admin
action to `POST /admin/shards/:id/drain` so placement stops targeting that
shard while later orchestration work supplies actual machine replacement.
