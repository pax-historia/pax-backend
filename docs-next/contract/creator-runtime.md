# Creator runtime contract

> Layer: **Contract**

This is the surface a bundle author programs against. It is the **only**
surface a bundle sees of the substrate. `@pax-backend/runtime-sdk` exports
typed wrappers around every entry in this contract; the IPC envelope and
the parent-actor implementation enforce the contract end-to-end.

The contract is stable. Bundles compile against a specific
`runtimeContractRequired` integer; substrate shards advertise a supported
range (`runtimeContractsSupported: [min, max]`); placement refuses
mismatches (guarantee #16).

## Bundle shape

A bundle exports a single value from its entry module:

```ts
import { defineBundle } from '@pax-backend/runtime-sdk';

export default defineBundle({
  manifest: {
    compatTagProduced: 'historia:v5',
    compatTagsAccepted: ['historia:v3', 'historia:v4', 'historia:v5'],
    runtimeContractRequired: 1
  },

  async onWake(c, { reason, runId, bundleName, bundleCompatTag, blobCompatTag, state }) {
    // ...
  },

  async onPlayerConnect(c, { playerId, sessionId, jwtClaims, connectedAt }) {
    // ...
  },

  // ... other hooks
});
```

`defineBundle` validates the manifest at module load:

- `compatTagProduced` is a non-empty string.
- `compatTagsAccepted` is a non-empty string array.
- `compatTagsAccepted` includes `compatTagProduced` (a bundle must be able
  to read what it writes).
- `runtimeContractRequired` is a positive integer.

If any check fails, the bundle fails to load and the substrate emits
`bundle.loaded.failed` to history. The same validation runs on
`POST /admin/bundles/:bundleName` so bad manifests can't be uploaded.

## Lifecycle hooks

Seven hooks. All optional. All may return a promise. All receive `(c,
payload)`.

| Hook | When called | Payload | See |
|---|---|---|---|
| `onWake` | The game starts, restarts, reconnects, migrates, or upgrades | `OnWakePayload` | [`lifecycle-and-wake.md`](lifecycle-and-wake.md) |
| `onSleep` | The substrate is giving the bundle a bounded flush window before sleep, shutdown, eviction, or upgrade | `OnSleepPayload` | [`lifecycle-and-wake.md`](lifecycle-and-wake.md) |
| `onPlayerConnect` | A whitelisted player connects | `OnPlayerConnectPayload` | [`lifecycle-and-wake.md`](lifecycle-and-wake.md) |
| `onPlayerDisconnect` | A connected session leaves or is forcibly removed | `OnPlayerDisconnectPayload` | [`lifecycle-and-wake.md`](lifecycle-and-wake.md) |
| `onPlayerMessage` | A player sends a WS message | `OnPlayerMessagePayload` | [`lifecycle-and-wake.md`](lifecycle-and-wake.md) |
| `onCapacityWarning` | A compute budget is approaching its limit | `OnCapacityWarningPayload` | [`compute-budgets.md`](compute-budgets.md) |
| `onHostEvent` | A `POST /admin/games/:id/host-event` was delivered | `OnHostEventPayload` | [`lifecycle-and-wake.md`](lifecycle-and-wake.md) |

Deliberately not exposed: `onCreate` and `onMigrate` (folded into
`onWake` reasons), `onDestroy` (admin action; the child just stops
loading), `run` or `onTimer` (no background loops the substrate can't
account for; see
[`why/why-no-scheduled-wakeups.md`](../why/why-no-scheduled-wakeups.md)),
`onWebSocket` / `onRequest` (transport is substrate-owned), `onStateChange`
(the bundle owns its own write paths), Rivet `actions` (folded into
`onPlayerMessage`).

## The `c` context object

Every hook receives a fresh `c` object with the methods below. `c` is
typed as `SubstrateContext` in `@pax-backend/runtime-sdk`. Hook payloads
are the second argument.

### Determinism

| Method | Returns | Notes |
|---|---|---|
| `c.rng()` | `number` in [0,1) | Deterministic in scenario-runner test mode (seeded from `PAX_TEST_SEED`); cryptographic-quality in production |
| `c.now()` | `number` (ms since epoch) | Deterministic in test mode; wall clock in production |

Bundles must use `c.rng()` and `c.now()` instead of `Math.random()` and
`Date.now()`. The bundle-tools `verify` command lints the source for
direct usage. Deterministic test runs depend on this.

### Websocket I/O

| Method | Returns | Notes |
|---|---|---|
| `c.ws.send(target, body)` | `WsSendResponse` | `target` is `'all'`, a `playerId`, or a `readonly string[]` of `playerId`s. `body` is JSON-serializable |

`WsSendResponse` is `{ ok: true, sent: number, bytes: number }` or
`{ ok: false, error: 'bandwidthExceeded' | 'rateExceeded' |
'serializationFailed' | 'targetInvalid' | 'targetNotConnected',
detail?: unknown }`.

Bandwidth and rate errors come from compute budget enforcement;
`serializationFailed` is returned synchronously if the body isn't JSON-safe
(before IPC). `targetInvalid` and `targetNotConnected` are parent-side
refusals; no frame is sent.

### Observability

| Method | Returns | Notes |
|---|---|---|
| `c.log.emit(payload)` | `void` | Structured log; routed to observability backend with `(gameId, bundleName, bundleCompatTag)` tags |
| `c.log.debug(msg, attrs?)` | `void` | Sugar for `c.log.emit({ level: 'debug', message: msg, ...attrs })`. Same for `info`, `warn`, `error` |
| `c.metrics.emit(payload)` | `void` | Numeric metric; counter / gauge / histogram shapes |
| `c.metrics.counter(name, value=1, labels?)` | `void` | Sugar |
| `c.metrics.gauge(name, value, labels?)` | `void` | Sugar |
| `c.metrics.histogram(name, value, labels?)` | `void` | Sugar |
| `console.log/info/warn/error/debug` | `void` | Proxied via `c.log.emit` with `event: 'console'`, `source: 'console'`, normalized args |

Metric names must start with `pax_creator_*`; substrate-side metrics use
`pax_*` (other namespaces) and won't accept overlapping names. Labels are
capped at 16 distinct combinations per metric per game.

### Lifecycle

| Method | Returns | Notes |
|---|---|---|
| `c.lifecycle.requestSleep()` | `void` | Voluntary sleep request. The substrate **may** later call `onSleep`. Idempotent — multiple requests collapse |

### URL services

| Method | Returns | Notes |
|---|---|---|
| `c.api.invoke(kind, args, options?)` | `Promise<ApiInvokeResponse>` | See [`external-api-channel.md`](external-api-channel.md) |

### Session views

| Method | Returns | Notes |
|---|---|---|
| `c.players.allowed()` | `Promise<readonly playerId[]>` | The substrate-owned per-game whitelist |
| `c.players.connected()` | `Promise<readonly ConnectedSession[]>` | Live snapshot. `ConnectedSession = { sessionId, playerId, connectedAt }` |

### Compute views

| Method | Returns | Notes |
|---|---|---|
| `c.compute.budget()` | `Promise<ComputeBudgetSnapshot>` | Current usage and configured limits for all eight budgets |

### State tier

| Method | Returns | Notes |
|---|---|---|
| `c.state.read()` | `Promise<unknown>` | Whole-object read; returns the cached value (which is the canonical value mod the flush window) |
| `c.state.write(value)` | `Promise<StorageWriteResponse>` | Whole-object write; queues a flush within the configured window |
| `c.state.flush()` | `Promise<StorageWriteResponse>` | Forces an immediate synchronous Tigris flush |

### Blob tier

| Method | Returns | Notes |
|---|---|---|
| `c.blob.put(key, bytes)` | `Promise<StorageWriteResponse>` | Async; durable on resolve |
| `c.blob.get(key)` | `Promise<Uint8Array \| null>` | Returns `null` if the key doesn't exist |
| `c.blob.delete(key)` | `Promise<{ ok: true }>` | Idempotent |
| `c.blob.list(prefix?)` | `Promise<readonly { key: string, size: number }[]>` | Lists keys in the per-game namespace (optionally prefix-filtered) |

`StorageWriteResponse` is `{ ok: true }` or `{ ok: false, error:
'sizeExceeded' | 'keyCountExceeded' | 'storageUnavailable', detail?:
unknown }`.

See [`storage.md`](storage.md) for the full storage tier contract,
[`compute-budgets.md`](compute-budgets.md) for the cap details.

## Versioning

Three independent version identifiers participate in the contract:

| Axis | Boundary | Mechanism | Substrate opinion |
|---|---|---|---|
| **A. Bundle ↔ substrate** | Child ↔ parent actor | `runtimeContractRequired: int` (bundle) and `runtimeContractsSupported: [min, max]` (shard); placement gate | Single linear evolution |
| **B. Substrate ↔ URL service** | Gateway ↔ URL service | `X-Gateway-Envelope-Version: 2` HTTP header | Single linear evolution |
| **C. Bundle ↔ URL service app** | Creator code ↔ URL service application logic | Version baked into kind name (`ai.chat.v1`) | Opaque |

There is no fourth axis. Channel payloads carry no in-band version field —
the shard knows the contract version from the manifest before parsing any
payload.

## What the contract guarantees the bundle

Beyond the surface above, the contract commits to:

- **Idempotent player input.** `(playerId, seq)` is never delivered twice
  (guarantee #6).
- **Stable `sessionId`.** The same `sessionId` shows up in every related
  hook, in `c.api.invoke` context envelopes, and in history (guarantee #3).
- **Authoritative session observability.** `c.players.connected()` and the
  `connectedSessions` snapshot in `api.invoke` envelopes reflect the
  substrate's actual state (guarantee #4).
- **No random parent crashes.** Process death without `onSleep` is a
  substrate bug; the bundle doesn't have to defend against it
  (guarantee #9).
- **Eviction minimum budget.** `onSleep` always gives the bundle at least
  the documented minimum to flush (guarantee #10).
- **`c.state` flush window durability.** Planned transitions lose zero
  writes; unplanned death loses at most the flush window (guarantee #11).
- **`c.blob` survival.** Every `put` is durable on resolve; the namespace
  survives cross-shard, cross-deploy, cross-volume-loss (guarantee #12).

See [`vision/guarantees.md`](../vision/guarantees.md) for the full list.

## What the contract requires of the bundle

- **Use `c.rng()` / `c.now()`** instead of native `Math.random()` /
  `Date.now()`. (Verified by `pax-bundle verify`.)
- **Be idempotent on `(playerId, seq)`.** The substrate dedupes at the
  edge but rare race conditions during restart can theoretically
  redeliver; bundles should treat `seq` as a dedup key.
- **Be idempotent on `(eventType, payload)` for host events.** Same
  reason; guarantee #17 is at-least-once.
- **Flush before relying on durability.** Reads after writes within the
  flush window see the new value (cache is read-through). Crash safety
  before durability requires `await c.state.flush()`.
- **Honor `onSleep`'s deadline.** Returning past the deadline = killed
  and last checkpoint kept.

## Cross-references

- [`lifecycle-and-wake.md`](lifecycle-and-wake.md) — hook payloads in
  detail
- [`storage.md`](storage.md) — `c.state` and `c.blob` semantics
- [`compute-budgets.md`](compute-budgets.md) — the eight budgets, error
  taxonomy
- [`external-api-channel.md`](external-api-channel.md) — `c.api.invoke`
  and the envelope
- [`bundle-compatibility.md`](bundle-compatibility.md) — manifest gates
- [`history-events.md`](history-events.md) — what the substrate records
- [`reference/error-codes.md`](../reference/error-codes.md) — canonical
  error code taxonomy
