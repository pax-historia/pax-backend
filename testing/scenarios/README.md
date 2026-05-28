# `testing/scenarios/`

First-party scenarios that ship in CI. See [`../README.md`](../README.md)
for the broader rules about the `testing/` zone (kind-folders,
`_internal/` escape hatch, etc.).

| Scenario | What it exercises |
|---|---|
| `chat-steady-state/` | The baseline load shape from `pax-spike-fly` (chat-like games, steady connect/disconnect/message churn). Regression guard. |
| `compromised-bundle-adversarial/` | Hostile creator bundle behavior. Asserts a bundle cannot silently send to a missing player target and instead receives a typed `targetNotConnected` refusal. |
| `compute-stress/` | The renamed `billing-fuzz`. **No business-plane resources** — focuses on CPU-ms-per-tick, bandwidth-bytes-per-sec, ws-messages-per-sec, api-invocations-per-min. |
| `jwt-adversarial/` | Misrouted placement JWT handshakes. Asserts the parent records a typed refusal and never opens a session. |
| `shard-death-resilience/` | Composed with the `shard-death-every-5m` nemesis; asserts `c.state` flush-window durability (guarantee #11), `c.blob` namespace durability across shard loss (guarantee #12), and `cold-restart-from-storage` behavior on the next wake. |

## Per-scenario layout

```
<scenario>/
  bundle/                # creator code (or a ref to examples/bundles/)
  clients/               # client-side script
  fixtures/              # initial state, allowed-players, api-responses
  oracles.ts             # which oracle-lib oracles fire
  manifest.ts            # PRNG seed, determinism level, etc.
```

Current source pass adds scenario manifests, declarative client workload
plans, default nemesis selection, oracle selections, and inline fixtures for
the first-party scenario catalog. `api-responses` fixtures
are gateway wire-record JSON/JSONL files keyed by outbound fingerprint; the
scenario runner resolves their paths into `PAX_API_REPLAY_FIXTURES_PATH` for
the gateway replay environment. Workload execution and bundle wiring still
land in later passes.
