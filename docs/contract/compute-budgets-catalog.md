# Compute-plane budget catalog

These are the eight enumerated compute budgets the substrate enforces per
game (see [plan README](../../README.md) §"Compute-plane resources"):

| Budget | Window | On violation |
|---|---|---|
| `cpu-ms-per-tick` | Per lifecycle/player handler | Handler timeout recorded as `handlerTimeout`; child stays alive |
| `memory-bytes` | Steady-state RSS | Child killed (OOM); restart with `cold-restart-after-crash`, `errorClass: 'oom'` |
| `bandwidth-bytes-per-sec` | Sliding 1-second | `ws.send` returns `bandwidthExceeded` |
| `ws-messages-per-sec` | Sliding 1-second | `ws.send` returns `rateExceeded` |
| `state-bytes` | Total `c.state` size | `state.write` returns `sizeExceeded` |
| `blob-bytes` | Total bytes across all keys in the `c.blob` namespace | `blob.put` returns `sizeExceeded` |
| `blob-keys` | Distinct key count in the `c.blob` namespace | `blob.put` returns `keyCountExceeded` |
| `api-invocations-per-min` | Sliding 1-minute | `api.invoke` returns `apiRateExceeded`; URL service not contacted |

Current shard defaults are `1000ms` per handler, `128MiB` RSS, `64KiB/s`
websocket bandwidth, `50` websocket sends per second, `128KiB` state,
`100MiB` blob bytes, `1024` blob keys, and `60` API invocations per
minute. Operators can tune these with the corresponding `PAX_*` budget
environment variables on the shard.

**Not in this catalog and never will be:** AI tokens, image credits, gold,
balances, debits, reservations, refunds. Those are operator-owned URL-service
concerns. See [../why/why-no-billing.md](../why/why-no-billing.md).
