# Compute-plane budget catalog

> Stub. Defaults will be set during step 6 of the plan's kickoff.

These are the seven enumerated compute budgets the substrate enforces per
game (see [plan README](../../README.md) §"Compute-plane resources"):

| Budget | Window | On violation |
|---|---|---|
| `cpu-ms-per-tick` | Per lifecycle/player handler | Handler timeout recorded as `handlerTimeout`; child stays alive |
| `memory-bytes` | Steady-state RSS | Child killed (OOM); restart with `cold-restart-after-crash`, `errorClass: 'oom'` |
| `bandwidth-bytes-per-sec` | Sliding 1-second | `ws.send` returns `bandwidthExceeded` |
| `ws-messages-per-sec` | Sliding 1-second | `ws.send` returns `rateExceeded` |
| `state-bytes` | Total | `state.write` returns `sizeExceeded` |
| `blob-bytes` | Total | `blob.write` returns `sizeExceeded` |
| `api-invocations-per-min` | Sliding 1-minute | `api.invoke` returns `apiRateExceeded`; URL service not contacted |

**Not in this catalog and never will be:** AI tokens, image credits, gold,
balances, debits, reservations, refunds. Those are operator-owned URL-service
concerns. See [../why/why-no-billing.md](../why/why-no-billing.md).
