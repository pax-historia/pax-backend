# Compute budgets

> Layer: **Contract**

The substrate enforces eight compute-plane resource budgets per game. They
are first-class, per-game-instance, and reset per-window. They are
**NOT** the same as "AI tokens" or "image credits" or any vercel-backend
business resource (those don't exist in the substrate at all — see
[`why/why-no-billing.md`](../why/why-no-billing.md)).

## The eight enumerated budgets

| Budget | Window | Default | Enforcement |
|---|---|---|---|
| `cpu-ms-per-tick` | Per lifecycle/player handler invocation | 1000 ms | Handler killed if exceeded; isolate stays alive |
| `memory-bytes` | Per-isolate cap (generous per preset); admission reserves player-scaled actual | 128 MiB | Isolate disposed on cap hit; restart `cold-restart-after-crash`, `errorClass: 'oom'`; co-tenants unaffected |
| `bandwidth-bytes-per-sec` | Sliding 1-second window | 64 KiB/s | `c.ws.send` returns `bandwidthExceeded`; isolate stays alive |
| `ws-messages-per-sec` | Sliding 1-second window | 50/s | `c.ws.send` returns `rateExceeded`; isolate stays alive |
| `state-bytes` | Size of the `c.state` object | 128 KiB | `c.state.write` returns `sizeExceeded` |
| `blob-bytes` | Sum of all keys in the optional `c.blob` namespace | 100 MiB | `c.blob.put` returns `sizeExceeded` |
| `blob-keys` | Distinct key count in the optional `c.blob` namespace | 1024 | `c.blob.put` returns `keyCountExceeded` |
| `api-invocations-per-min` | Sliding 1-minute window | 60/min | `c.api.invoke` returns `apiRateExceeded`; URL service not contacted |

## Why exactly these eight

Each budget is something **only the runtime can measure** — the bundle
running inside the sandbox cannot reliably observe its own memory RSS,
its own outbound bandwidth, or the global API rate across all its
sessions. The substrate measures from outside and feeds the bundle's
own view via `c.compute.budget()`.

Anything operators want to enforce that's **not** in this list — AI
tokens, credits, currency, balances, refunds, spectator-shaped caps,
per-game-pool — is a URL service concern. See
[`operator-overlays/billing-policy.md`](../operator-overlays/billing-policy.md).

## The `c.compute.budget()` snapshot

```ts
c.compute.budget(): Promise<ComputeBudgetSnapshot>

interface ComputeBudgetSnapshot {
  'cpu-ms-per-tick':         { used: number, limit: number };
  'memory-bytes':            { used: number, limit: number };
  'bandwidth-bytes-per-sec': { used: number, limit: number };
  'ws-messages-per-sec':     { used: number, limit: number };
  'state-bytes':             { used: number, limit: number };
  'blob-bytes':              { used: number, limit: number };
  'blob-keys':               { used: number, limit: number };
  'api-invocations-per-min': { used: number, limit: number };
}
```

`used` reflects the **substrate's authoritative measurement** at call
time. The bundle's view is read-only — there is no "set my own budget"
API.

## Per-preset overrides

The substrate ships compute budget defaults at the values above. The
vercel backend can override per-preset via the preset manifest
(out-of-scope for the substrate — overrides are passed through at game
creation via initial bundle environment).

Practical envelope (all in units the corresponding budget cares about):

- `cpu-ms-per-tick`: 100 – 10000 ms
- `memory-bytes`: 64 MiB – 512 MiB
- `bandwidth-bytes-per-sec`: 16 KiB/s – 1 MiB/s
- `ws-messages-per-sec`: 10 – 500
- `state-bytes`: fixed at 128 KiB
- `blob-bytes`: fixed at 100 MiB
- `blob-keys`: fixed at 1024
- `api-invocations-per-min`: 10 – 600

Values outside these envelopes are rejected at game create.

## Enforcement detail

### Handler-tick CPU

The Runner wraps each handler invocation with a per-handler timeout (the
`cpu-ms-per-tick` value). If the handler doesn't return within that
window, the Runner emits a handler-timeout (`handler.error`,
`code: 'handlerTimeout'`) and the Broker records
`compute.budget.rejected` for `cpu-ms-per-tick`. The handler's promise is
rejected with a typed error; the isolate stays alive for the next handler.

The bundle author can call `c.compute.budget()` mid-handler to see how
much CPU they've burned and decide whether to early-return.

### Memory

`isolated-vm` enforces a per-isolate memory cap, fixed at isolate
creation and set generously per preset. The Runner samples per-isolate
heap and its own process RSS and reports to the Broker; admission counts
the **player-scaled reservation**, not the cap (see
[`subsystems/broker.md`](../subsystems/broker.md) §Resource model). If a
game hits its cap, the Runner disposes that one isolate and the Broker
re-wakes it (`cold-restart-after-crash`, `errorClass: 'oom'`) **without
disturbing co-tenants** (guarantee #8).

### Bandwidth and message rate

Both are sliding 1-second windows tracked by the Broker on outbound
`c.ws.send` calls (where fan-out also happens). The Broker rejects an
over-budget send with the appropriate typed error code; the bundle's send
promise resolves to `{ ok: false, error: 'bandwidthExceeded' |
'rateExceeded' }`.

A rejected send is **not** retried by the substrate. The bundle decides
whether to retry, drop, or batch.

### State, blob bytes, blob keys

All three are checked by the Broker on `c.state.write` / `c.blob.put`,
before the write enters the cache. An over-budget write is rejected
immediately; `{ ok: false, error: ... }` is returned synchronously.

### API invocations per minute

Sliding 1-minute window per game tracked at the gateway. Over-budget
invokes never contact the URL service — the gateway returns
`{ ok: false, error: 'apiRateExceeded' }` immediately.

This is the only budget where the Broker (which sees the bridge request)
and the gateway (which sees the dispatch) both participate. The gateway is
the authoritative counter; the Broker's `c.compute.budget()` snapshot
queries the gateway for the live value.

## Capacity warnings

When usage approaches a budget's limit (default threshold: 80%), the
substrate fires `onCapacityWarning` to the bundle:

```ts
onCapacityWarning(c, { budget, currentUsage, limit }) {
  // Best-effort hint. Bundle decides what to do.
  // No guarantee of when this fires; substrate may skip if multiple budgets warn simultaneously.
}
```

The warning is **best-effort**: the substrate fires when convenient, not
on a strict polling cadence. It exists so the bundle can degrade
gracefully (slow down broadcasts, defer non-essential work).

Warnings do not affect enforcement. A budget at 99% still enforces; a
budget at 50% will not warn.

## Cross-budget interactions

- `state-bytes` caps the single state object; `blob-bytes` caps the
  optional keyed tier. They are independent.
- `bandwidth-bytes-per-sec` is **outbound only**; inbound (from clients)
  is constrained by WS frame size + frame rate, not a separate budget.
- `api-invocations-per-min` is independent of any URL service's own rate
  limits — a `c.api.invoke` that passes the substrate's budget but is
  rate-limited by the URL service returns `providerError`, not
  `apiRateExceeded`.
- `memory-bytes` is the per-isolate cap; the Runner's process RSS is
  shared across co-tenants and reconciled separately. Admission accounts
  for the player-scaled reservation, not the (oversubscribed) caps.

## Cross-references

- [`reference/error-codes.md`](../reference/error-codes.md) — full taxonomy
- [`subsystems/broker.md`](../subsystems/broker.md) — most enforcement
  lives here
- [`subsystems/api-gateway.md`](../subsystems/api-gateway.md) —
  `api-invocations-per-min` enforcement
- [`vision/guarantees.md`](../vision/guarantees.md) #7
- [`storage.md`](storage.md) — `state-bytes`, `blob-bytes`, `blob-keys`
  context
