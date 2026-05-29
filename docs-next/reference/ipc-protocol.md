# Runtime bridge protocol

> Layer: **Reference catalog**

The runtime bridge is the wire between a game's isolate (untrusted), the
credential-less Runner that hosts it, and the shard's trusted Broker. It
has **two boundaries**:

1. **Isolate ↔ Runner (in-process).** The `c.*` shim inside the isolate
   calls Runner-provided functions via `isolated-vm`'s promise-returning
   `apply`. No requestId bus inside the isolate — the isolate just
   `await`s; a waiting isolate yields the Runner's event loop so co-tenants
   run.
2. **Runner ↔ Broker (cross-process).** A single async IPC channel per
   Runner, multiplexing every game the Runner hosts. RequestId-based
   request/response; many requests in flight; nothing blocks.

This page is the canonical envelope and channel-name contract for both
boundaries. The implementation lives in
[`@pax-backend/ipc-protocol`](../../shared/ipc-protocol/) (TypeScript
types consumed by the Runner and the Broker). The envelope shape is
governed by the **runtime contract version** (Axis A in
[`bundle-compatibility.md`](../contract/bundle-compatibility.md)); no
in-band per-payload version field.

The conceptual surface — what each channel does for the bundle — lives in
[`contract/creator-runtime.md`](../contract/creator-runtime.md) and
[`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md).
This page is the wire reference.

## Envelope (Runner ↔ Broker)

Every cross-process message is one structured envelope over a local IPC
channel (a Unix socket / pipe; JSON objects, not arbitrary serialized JS).
Because one channel multiplexes many games, the envelope carries a
Broker-stamped `gameId` for routing within the Runner.

```ts
interface BridgeEnvelope<T extends string = string, P = unknown> {
  version: 1;                     // runtime contract version (Axis A)
  type: T;                        // channel name (one of the lists below)
  gameId: string;                 // which game this message targets (Broker-stamped)
  payload: P;                     // channel-specific shape
  requestId?: string;             // present on request/response pairs
  traceId?: string;               // W3C trace_id; for distributed tracing
  spanId?: string;                // W3C span_id; one hop within a trace
  ts_ns?: number;                 // emit timestamp (nanoseconds since epoch)
}
```

The Broker validates every inbound envelope from a Runner:

- `version` must equal the runtime contract version the shard advertises.
- `type` must be in the enumerated Runner→Broker channel set below.
- `payload` shape must match the channel's payload schema.
- `gameId` must be **assigned to that Runner**; the Broker rejects any
  request for a game the Runner does not host.
- The Broker **stamps** `gameId`, `sessionId`, `playerId`, `seq`,
  `connectedAt` from its own session state — it never trusts these from a
  Runner or isolate.

A malformed envelope is logged as `runner.unknownMessage` and dropped.
The substrate does not crash a Runner for a single bad envelope; the
Runner hosts untrusted code and may misbehave.

## Channel set — Broker → Runner

| Channel | Purpose | Payload type |
|---|---|---|
| `assign` | Create an isolate for a game and eval its bundle (one-time per wake) | `AssignPayload` |
| `release` | Dispose a game's isolate (after checkpoint) | `{ }` |
| `onWake` | Lifecycle dispatch | `OnWakePayload` |
| `onSleep` | Lifecycle dispatch | `OnSleepPayload` |
| `onPlayerConnect` | Lifecycle dispatch | `OnPlayerConnectPayload` |
| `onPlayerDisconnect` | Lifecycle dispatch | `OnPlayerDisconnectPayload` |
| `onPlayerMessage` | Lifecycle dispatch | `OnPlayerMessagePayload` |
| `onCapacityWarning` | Lifecycle dispatch (best-effort) | `OnCapacityWarningPayload` |
| `onHostEvent` | Lifecycle dispatch | `OnHostEventPayload` |
| `state.read.response` | Response to a `state.read` request | `{ value: unknown }` |
| `state.write.response` | Response to a `state.write` request | `StorageWriteResponse` |
| `state.flush.response` | Response to a `state.flush` request | `StorageWriteResponse` |
| `blob.put.response` | Response to a `blob.put` request | `StorageWriteResponse` |
| `blob.get.response` | Response to a `blob.get` request | `{ value: Uint8Array \| null }` |
| `blob.delete.response` | Response to a `blob.delete` request | `{ ok: true }` |
| `blob.list.response` | Response to a `blob.list` request | `{ items: readonly { key, size }[] }` |
| `api.invoke.response` | Response to an `api.invoke` request | `ApiInvokeResponse` |
| `ws.send.response` | Response to a `ws.send` request | `WsSendResponse` |
| `players.allowed.response` | Response to a `players.allowed` request | `{ items: readonly string[] }` |
| `players.connected.response` | Response to a `players.connected` request | `{ items: readonly ConnectedSession[] }` |
| `compute.budget.response` | Response to a `compute.budget` request | `ComputeBudgetSnapshot` |

## Channel set — Runner → Broker

| Channel | Purpose | Request/Response |
|---|---|---|
| `runner.ready` | Runner process is up and ready to accept assignments | One-shot; no response |
| `isolate.ready` | A game's isolate is up and the bundle is eval'd | One-shot |
| `state.read` | Read `c.state` | Request → `state.read.response` |
| `state.write` | Write the `c.state` object | Request → `state.write.response` |
| `state.flush` | Force an immediate checkpoint | Request → `state.flush.response` |
| `blob.put` | Write a blob namespace key | Request → `blob.put.response` |
| `blob.get` | Read a blob namespace key | Request → `blob.get.response` |
| `blob.delete` | Delete a blob namespace key | Request → `blob.delete.response` |
| `blob.list` | List blob namespace keys | Request → `blob.list.response` |
| `api.invoke` | Call a URL service kind | Request → `api.invoke.response` |
| `ws.send` | Send a WS frame to one or more players | Request → `ws.send.response` |
| `players.allowed` | Read allowed-players set | Request → `players.allowed.response` |
| `players.connected` | Read connected-sessions snapshot | Request → `players.connected.response` |
| `compute.budget` | Read compute budget snapshot | Request → `compute.budget.response` |
| `log.emit` | Emit a structured log | One-shot |
| `metrics.emit` | Emit a metric | One-shot |
| `lifecycle.requestSleep` | Voluntary sleep request | One-shot |
| `lifecycle.sleepComplete` | Bundle finished flushing in `onSleep` | One-shot |
| `handler.complete` | CPU telemetry — handler returned | One-shot |
| `handler.error` | CPU telemetry — handler threw or timed out | One-shot |
| `isolate.fatal` | A game's isolate hit a fatal error (e.g. cap-hit OOM); about to be disposed | One-shot |
| `isolate.counters` | Periodic per-isolate cpu/heap sample (capacity/observability input) | One-shot |

Request/response channels carry a matching `requestId` on both sides.
One-shot channels do not. A `runner.crash` (native death of the whole
Runner process) is observed by the Broker as channel disconnect, not as a
message.

## The isolate ↔ Runner boundary

Inside the isolate, the `c.*` shim calls Runner-provided functions with
`isolated-vm`'s promise-returning `apply` (`{ result: { promise: true }
}`). The isolate's code reads as ordinary `await c.state.read()`. There is
no requestId bus inside the isolate — the promise resolves when the Runner
answers. The Runner then relays the request to the Broker over the
cross-process channel above (adding the Broker-stamped `gameId`), awaits
the response, and resolves the isolate's promise.

The per-handler CPU timeout is applied by the Runner around each handler
invocation; it can interrupt a tight loop independent of the bridge.

## Lifecycle payload schemas

The full schemas live in
[`@pax-backend/ipc-protocol`](../../shared/ipc-protocol/). The summary
matches [`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md):

### `AssignPayload`

```ts
interface AssignPayload {
  bundleName: string;
  bundleSource: string;        // the compiled JS the Runner evals into the isolate
  bundleCompatTag: string;     // == bundle.manifest.compatTagProduced
  runId: string | null;        // scenario-only; null in production
  memoryLimitMb: number;       // memory-bytes cap for the isolate (generous per preset)
  handlerTimeoutMs: number;    // cpu-ms-per-tick budget per handler
  testSeed?: number;           // deterministic c.rng / c.now in test mode
}
```

`gameId` is on the envelope, not the payload (Broker-stamped). The bundle
source is delivered by the Broker because the Runner has no Tigris
credentials.

### `OnWakePayload`

```ts
interface OnWakePayload {
  reason: WakeReason;
  errorClass?: 'oom' | 'crash' | 'cpuTimeout' | 'unknown';
  runId: string | null;        // scenario-only; null in production
  bundleName: string;
  bundleCompatTag: string;
  blobCompatTag?: string;      // undefined on cold-start
  state: unknown | null;       // the state object (already materialized by the Broker)
}

type WakeReason =
  | 'cold-start'
  | 'reconnect'
  | 'cold-restart-after-crash'
  | 'cold-restart-after-eviction'
  | 'cold-restart-from-storage'
  | 'upgrade';
```

Note: the legacy `cold-restart-after-shard-loss` reason has been folded
into `cold-restart-from-storage`, which covers both planned cross-shard
migration and unplanned shard loss. The bundle does not need to
distinguish.

### `OnSleepPayload`

```ts
interface OnSleepPayload {
  deadline: number;                          // ms since epoch
  reason: 'idle' | 'requestedBySleep' | 'evicted' | 'shardEvicted' | 'shutdown' | 'upgrade';
}
```

### `OnPlayerConnectPayload`

```ts
interface OnPlayerConnectPayload {
  playerId: string;
  sessionId: string;                          // substrate-generated; opaque
  jwtClaims: Record<string, unknown>;         // verbatim claims from the JWT, including passthrough
  connectedAt: number;                        // ms since epoch
}
```

### `OnPlayerDisconnectPayload`

```ts
interface OnPlayerDisconnectPayload {
  playerId: string;
  sessionId: string;
  reason: 'left' | 'timedOut' | 'removedFromAllowedPlayers' | 'shardEvicted' | 'gameDeleted';
}
```

### `OnPlayerMessagePayload`

```ts
interface OnPlayerMessagePayload {
  playerId: string;
  sessionId: string;
  seq: number;                                // per-session monotonic; substrate-assigned
  body: unknown;                              // JSON-parsed WS frame body
}
```

### `OnCapacityWarningPayload`

```ts
interface OnCapacityWarningPayload {
  budget: ComputeBudgetName;                  // see compute-budgets.md
  currentUsage: number;
  limit: number;
}
```

### `OnHostEventPayload`

```ts
interface OnHostEventPayload {
  eventType: string;
  payload: unknown;                           // opaque to substrate
  receivedAt: number;                         // ms since epoch
}
```

## Storage payload schemas

### `state.write` / `c.state.write`

```ts
// Request
interface StateWriteRequest {
  value: unknown;                             // the one state object; ≤ state-bytes (default 128 KB) encoded
}

// Response (StorageWriteResponse)
type StorageWriteResponse =
  | { ok: true }
  | { ok: false; error: 'sizeExceeded' | 'keyCountExceeded' | 'storageUnavailable'; detail?: unknown };
```

`state.read` and `state.flush` use empty request payloads. `state.write`
lands in the Broker's per-game cache and marks the game dirty; durability
happens at the next checkpoint (`state.flush` forces one). See
[`subsystems/state-store.md`](../subsystems/state-store.md).

### `blob.put` / `c.blob.put`

```ts
// Request
interface BlobPutRequest {
  key: string;                                // ≤ 256 bytes; namespace-scoped
  bytes: Uint8Array;                          // ≤ blob-bytes total per game (across all keys)
}

// Response: StorageWriteResponse (with the keyCountExceeded variant in scope)
```

Like `state.write`, a `blob.put` lands in the cache and is committed at
the next checkpoint (the optional keyed tier is checkpoint-durable, not
durable-on-resolve).

### `blob.get` / `c.blob.get`

```ts
interface BlobGetRequest {
  key: string;
}

interface BlobGetResponse {
  value: Uint8Array | null;                   // null if the key does not exist
}
```

### `blob.delete` / `c.blob.delete`

```ts
interface BlobDeleteRequest {
  key: string;
}

interface BlobDeleteResponse {
  ok: true;                                   // idempotent
}
```

### `blob.list` / `c.blob.list`

```ts
interface BlobListRequest {
  prefix?: string;                            // optional key prefix filter
}

interface BlobListResponse {
  items: readonly { key: string; size: number }[];
}
```

## API + WS payload schemas

### `api.invoke`

```ts
// Request
interface ApiInvokeRequest {
  kind: string;
  args: unknown;                              // opaque to substrate
  idempotencyKey?: string;                    // pass-through to the URL service
}

// Response (ApiInvokeResponse)
type ApiInvokeResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: 'kindUnknown' | 'providerError' | 'apiRateExceeded' | 'replayCoverageGap'; detail?: unknown };
```

`triggeringSessionId` is **not** a Runner-supplied field — the Broker
stamps it from the dispatch context before forwarding to the gateway.

### `ws.send`

```ts
type WsTarget = 'all' | string | readonly string[];

interface WsSendRequest {
  target: WsTarget;
  body: unknown;                              // must be JSON-serializable
}

type WsSendResponse =
  | { ok: true; sent: number; bytes: number }
  | { ok: false; error: 'bandwidthExceeded' | 'rateExceeded' | 'serializationFailed' | 'targetInvalid' | 'targetNotConnected'; detail?: unknown };
```

`serializationFailed` is returned synchronously by the `c.*` shim **before
the bridge call** if `body` cannot be JSON-stringified. Fan-out
(`'all'` or an array) is performed by the Broker, not the isolate.

## Trust mechanics on the wire

The isolate is untrusted; the Runner is credential-less and not trusted to
assert identity. Every request the Broker receives carries data a bundle
could lie about; the Broker does not let it:

- The Broker stamps `gameId`, `sessionId`, `playerId`, `runId`, `seq`,
  `traceId`, `connectedAt`, and `triggeringSessionId` from its own state.
  Neither the isolate nor the Runner can influence these.
- The Broker rejects any request whose `gameId` is not assigned to the
  originating Runner.
- The Broker rejects envelopes whose `type` is outside the enumerated
  Runner→Broker set, and malformed payloads, emitting
  `runner.unknownMessage`.
- Compute budget counters (`bandwidth-bytes-per-sec`,
  `ws-messages-per-sec`, `state-bytes`, etc.) are tracked from the
  Broker's measurement, not from any Runner claim.

See [`vision/trust-model.md`](../vision/trust-model.md) for the full
three-ring threat model.

## Evolution rule

This contract evolves on **runtime contract version bumps only** (Axis A).
Adding a new channel:

1. Add the payload type and the envelope variant in
   [`shared/ipc-protocol`](../../shared/ipc-protocol/).
2. Add the channel name to the Broker's dispatcher and the Runner's
   handler set.
3. Bump `RUNTIME_CONTRACT_VERSION`.
4. The Broker and Runner pin to the same runtime contract version at build
   time; the placement gate (guarantee #16) ensures bundles compiled
   against version N only land on shards advertising N.

No in-band version field on individual payloads. The shard knows the
contract version from the bundle's manifest before any payload is parsed.

## End-state contract

A consumer of this protocol (the Broker dispatcher, the Runner, the SDK,
the smoke bot) can rely on:

- **One typed envelope shape covers every channel** on the cross-process
  boundary; `gameId` multiplexes games on a Runner's single channel.
- **Request/response channels are correlated by `requestId`.**
- **A waiting isolate yields the event loop** — its pending bridge call
  never freezes a co-tenant.
- **Bridge round trip isolate→Runner→Broker→isolate ≤ 5 ms p99** for
  non-storage channels (see [`subsystems/broker.md`](../subsystems/broker.md)).
- **Storage-mediated channels** (`state.*`, `blob.*`, `api.invoke`) have
  channel-specific p99s gated by cache vs underlying I/O.
- **Channel names are exhaustive** — the Broker's switch rejects unknown
  names; the Runner's adapter never emits names outside the catalog.

## Cross-references

- [`@pax-backend/ipc-protocol`](../../shared/ipc-protocol/) — TypeScript source of truth
- [`contract/creator-runtime.md`](../contract/creator-runtime.md) — what the bundle sees
- [`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md) — lifecycle payload semantics
- [`contract/storage.md`](../contract/storage.md) — storage contract
- [`contract/external-api-channel.md`](../contract/external-api-channel.md) — `c.api.invoke` semantics
- [`contract/compute-budgets.md`](../contract/compute-budgets.md) — budget names + error codes
- [`subsystems/broker.md`](../subsystems/broker.md) — Broker-side dispatch
- [`subsystems/runner.md`](../subsystems/runner.md) — Runner-side adapter and the in-process boundary
- [`vision/trust-model.md`](../vision/trust-model.md) — three-ring threat model
- [`event-schema.md`](event-schema.md) — what these channels record into history
- [`error-codes.md`](error-codes.md) — full error taxonomy
