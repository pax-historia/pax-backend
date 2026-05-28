# `testing/nemeses/`

Fault profiles, composed at scenario run time. Orthogonal to scenarios —
any nemesis can wrap any scenario. See [`../README.md`](../README.md) for
the broader rules about the `testing/` zone.

| Nemesis | What it does |
|---|---|
| `no-faults/` | The control. Same scenario, no injection. Reference for the others. |
| `shard-death-every-5m/` | Kills a random shard every 5 minutes. Used with `shard-death-resilience` (and as a soak overlay on the other scenarios). |

Stub. M4 lands the scenario-runner + first nemeses.
