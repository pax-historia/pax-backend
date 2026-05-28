# `tooling/nemeses/`

Fault profiles, composed at scenario run time. Orthogonal to scenarios — any
nemesis can wrap any scenario.

| Nemesis | What it does |
|---|---|
| `no-faults/` | The control. Same scenario, no injection. Reference for the others. |
| `shard-death-every-5m/` | Kills a random shard every 5 minutes. Used with `shard-death-resilience` (and as a soak overlay on the other scenarios). |

Stub.
