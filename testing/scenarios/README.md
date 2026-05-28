# `testing/scenarios/`

First-party scenarios that ship in CI. See [`../README.md`](../README.md)
for the broader rules about the `testing/` zone (kind-folders,
`_internal/` escape hatch, etc.).

| Scenario | What it exercises |
|---|---|
| `api-partition-adversarial/` | URL-service/API provider partition under active traffic. Asserts `mock-ai.v1` failures are typed `providerError`/`statusCode=0` wire records and recover after the nemesis restores the registration. |
| `chat-steady-state/` | The baseline load shape from `pax-spike-fly` (chat-like games, steady connect/disconnect/message churn). Regression guard. |
| `compromised-bundle-adversarial/` | Hostile creator bundle behavior. Asserts a bundle cannot silently send to a missing player target and instead receives a typed `targetNotConnected` refusal. |
| `compute-stress/` | Compute-budget edge probe. **No business-plane resources** — forces CPU timeout, websocket rate and bandwidth rejection, state/blob cap rejection, and API rate limiting. |
| `jwt-adversarial/` | Tampered, expired, and misrouted placement JWT handshakes. Asserts invalid tokens are refused, wrong-game tokens are recorded as typed refusals, and no session opens. |
| `race-and-deploy-adversarial/` | Host-event/sleep race, reconnect churn, and active bundle-flip collision guard using the `race-edge-probe` v1/v2 bundles. |
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
