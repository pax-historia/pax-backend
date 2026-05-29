# `runtime/` -- shard runtime packages

This zone contains the code that runs inside `pax-backend-shards` on the
Broker/Runner architecture described in [`docs-next/`](../docs-next/).

| Path | What it is |
|---|---|
| `broker/` | Shard-trusted Broker: WebSocket termination, sessions, budgets, history, state/blob/API mediation, capacity rows, and admin surfaces. |
| `runner/` | Credential-less Runner pool implementations. A Runner hosts many game isolates and talks to the Broker over request-id IPC. |
| `state-store/` | Broker-owned one-state-object cache and atomic checkpoint engine. |
| `shard-image/` | Production shard image and entrypoint that start Broker plus Vector. |

The creator-facing SDK lives under [`sdk/runtime-sdk`](../sdk/runtime-sdk/).
The Broker/Runner wire contract lives under
[`shared/ipc-protocol`](../shared/ipc-protocol/).
