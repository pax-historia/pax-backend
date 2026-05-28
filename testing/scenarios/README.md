# `testing/scenarios/`

First-party scenarios that ship in CI. See [`../README.md`](../README.md)
for the broader rules about the `testing/` zone (kind-folders,
`_internal/` escape hatch, etc.).

| Scenario | What it exercises |
|---|---|
| `chat-steady-state/` | The baseline load shape from `pax-spike-fly` (chat-like games, steady connect/disconnect/message churn). Regression guard. |
| `compute-stress/` | The renamed `billing-fuzz`. **No business-plane resources** — focuses on CPU-ms-per-tick, bandwidth-bytes-per-sec, ws-messages-per-sec, api-invocations-per-min. |
| `shard-death-resilience/` | Composed with the `shard-death-every-5m` nemesis; asserts `c.blob` durability across shard loss (guarantee #12) and `cold-restart-after-shard-loss` behavior. |

## Per-scenario layout

```
<scenario>/
  bundle/                # creator code (or a ref to examples/bundles/)
  clients/               # client-side script
  fixtures/              # initial state, allowed-players, url-service responses
  oracles.ts             # which oracle-lib oracles fire
  manifest.ts            # PRNG seed, determinism level, etc.
```

Current source pass adds the first scenario manifests, oracle selections, and
inline fixtures for the three planned first-party scenarios. Client drivers and
bundle wiring still land in later passes.
