# `tooling/scenarios/`

First-party scenarios that ship in CI:

| Scenario | What it exercises |
|---|---|
| `chat-steady-state` | The baseline load shape from `pax-spike-fly` (chat-like games, steady connect/disconnect/message churn). Regression guard. |
| `compute-stress` | The renamed `billing-fuzz`. **No business-plane resources** — focuses on CPU-ms-per-tick, bandwidth-bytes-per-sec, ws-messages-per-sec, api-invocations-per-min. |
| `shard-death-resilience` | Composed with the `shard-death-every-5m` nemesis; asserts `c.blob` durability across shard loss (guarantee #12) and `cold-restart-after-shard-loss` behavior. |

Stub.
