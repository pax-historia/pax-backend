# IPC protocol

> Layer: **Reference catalog**

The parent-child IPC is the wire between the parent actor (on the shard
machine, shard-local-trusted) and the child process (untrusted, running
the bundle in `isolated-vm`). One Node IPC channel per child, multiplexed
into typed envelopes.

This page is the canonical envelope and channel-name contract. The
implementation lives in
[`@pax-backend/ipc-protocol`](../../shared/ipc-protocol/) (TypeScript
types consumed by both the parent and the child). The IPC envelope shape
itself is governed by the **runtime contract version** (Axis A in
[`bundle-compatibility.md`](../contract/bundle-compatibility.md));
no in-band per-payload version field.

The conceptual surface — what each channel does for the bundle — lives
in [`contract/creator-runtime.md`](../contract/creator-runtime.md) and
[`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md).
This page is the wire reference.

## Envelope

Every IPC message is one structured envelope, exchanged over Node's
`child_process` IPC channel (the `serialization: 'json'` mode; messages
are JSON objects, not arbitrary serialized JS values).

```ts
interface IpcEnvelope<T extends string = string, P = unknown> {
  version: 1;                     // runtime contract version (Axis A)
  type: T;                        // channel name (one of the lists below)
  payload: P;                     // channel-specific shape
  requestId?: string;             // present on request/response pairs
  traceId?: string;               // W3C trace_id; for distributed tracing
  spanId?: string;                // W3C span_id; one hop within a trace
  ts_ns?: number;                 // emit timestamp (nanoseconds since epoch)
}
```

The parent validates every inbound envelope from the child:

- `version` must equal the runtime contract version the shard advertises.
- `type` must be in the enumerated child→parent channel set below.
- `payload` shape must match the channel's payload schema.
- The parent **stamps** `gameId` and `sessionId` from its own state — it
  never trusts these from the child.

A malformed envelope from the child is logged as `child.unknownMessage`
and dropped. The substrate does not crash the child for a single bad
envelope; the child is untrusted and may misbehave.

## Channel set — parent → child

| Channel | Purpose | Payload type |
|---|---|---|
| `bootstrap` | One-time startup payload sent immediately after the child reports ready | `BootstrapPayload` |
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

## Channel set — child → parent

| Channel | Purpose | Request/Response |
|---|---|---|
| `child.ready` | Child signals the isolate is up and ready to receive `bootstrap` | One-shot; no response |
| `state.read` | Read `c.state` | Request → `state.read.response` |
| `state.write` | Write `c.state` | Request → `state.write.response` |
| `state.flush` | Force-flush `c.state` to Tigris | Request → `state.flush.response` |
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
| `lifecycle.sleepComplete` | Bundle signals it has finished flushing in `onSleep` | One-shot |
| `child.handlerComplete` | CPU enforcement telemetry — handler returned | One-shot |
| `child.handlerError` | CPU enforcement telemetry — handler threw or timed out | One-shot |
| `child.fatal` | Child caught an uncaught error; about to exit | One-shot |

Request/response channels carry a matching `requestId` on both sides.
One-shot channels do not.

## Lifecycle payload schemas

The full schemas live in
[`@pax-backend/ipc-protocol`](../../shared/ipc-protocol/). The summary
here matches [`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md):

### `BootstrapPayload`

```ts
interface BootstrapPayload {
  bundleName: string;
  bundleSource: string;        // the compiled JS the child evals into the isolate
  bundleCompatTag: string;     // == bundle.manifest.compatTagProduced
  runId: string | null;        // scenario-only; null in production
  gameId: string;
  memoryLimitMb: number;       // memory-bytes budget for the isolate
  handlerTimeoutMs: number;    // cpu-ms-per-tick budget per handler
  testSeed?: number;           // PAX_TEST_SEED for deterministic c.rng / c.now
}
```

### `OnWakePayload`

```ts
interface OnWakePayload {
  reason: WakeReason;
  errorClass?: 'oom' | 'crash' | 'cpuTimeout' | 'unknown';
  runId: string | null;        // scenario-only; null in production
  bundleName: string;
  bundleCompatTag: string;
  blobCompatTag?: string;      // undefined on cold-start
  state: unknown | null;       // c.state contents (already hydrated by the parent)
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
  value: unknown;                             // CBOR-serializable; ≤ 128 KB encoded
}

// Response (StorageWriteResponse)
type StorageWriteResponse =
  | { ok: true }
  | { ok: false; error: 'sizeExceeded' | 'keyCountExceeded' | 'storageUnavailable'; detail?: unknown };
```

`state.read` and `state.flush` use empty request payloads.

### `blob.put` / `c.blob.put`

```ts
// Request
interface BlobPutRequest {
  key: string;                                // ≤ 256 bytes; namespace-scoped
  bytes: Uint8Array;                          // ≤ 100 MB total per game (across all keys)
}

// Response: StorageWriteResponse (with the keyCountExceeded variant in scope)
```

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
  triggeringSessionId: string | null;         // substrate fills this from the dispatch context
  idempotencyKey?: string;                    // pass-through to the URL service
}

// Response (ApiInvokeResponse)
type ApiInvokeResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: 'kindUnknown' | 'providerError' | 'apiRateExceeded' | 'replayCoverageGap'; detail?: unknown };
```

### `ws.send`

```ts
type WsTarget = 'all' | string | readonly string[];

interface WsSendRequest {
  target: WsTarget;
  body: unknown;                              // must be JSON-serializable
}

type WsSendResponse =
  | { ok: true; sent: number; bytes: number }
  | { ok: false; error: 'bandwidthExceeded' | 'rateExceeded' | 'serializationFailed'; detail?: unknown };
```

`serializationFailed` is returned synchronously by the child runner
**before IPC** if `body` cannot be JSON-stringified.

## Trust mechanics on the wire

The child is untrusted. Every IPC envelope from the child carries data
the bundle could lie about; the parent does not let it. Specifically:

- The parent stamps `gameId`, `sessionId`, `playerId`, `runId`, `seq`,
  `traceId`, and `connectedAt` from its own state. The child has no way
  to influence these values.
- The parent rejects envelopes whose `type` is outside the enumerated
  child→parent set, emitting `child.unknownMessage`.
- The parent rejects malformed payloads (schema mismatch), emitting the
  same.
- Compute budget counters (`bandwidth-bytes-per-sec`,
  `ws-messages-per-sec`, `state-bytes`, etc.) are tracked from the
  parent's measurement of inbound payloads, not from the child's claims.

See [`vision/trust-model.md`](../vision/trust-model.md) §"Untrusted: the
child process" for the full threat model.

## Evolution rule

This contract evolves on **runtime contract version bumps only** (Axis
A). Adding a new channel:

1. Add the payload type and the envelope variant in
   [`shared/ipc-protocol`](../../shared/ipc-protocol/).
2. Add the channel name to the parent's dispatcher and the child's
   handler set.
3. Bump `RUNTIME_CONTRACT_VERSION`.
4. The substrate's parent and child both pin to the same runtime
   contract version at build time; placement gate (guarantee #16)
   ensures bundles compiled against version N only land on shards
   that advertise N.

No in-band version field on individual payloads. The shard knows the
contract version from the bundle's manifest before any payload is
parsed.

## End-state contract

A consumer of this protocol (the parent dispatcher, the child runner,
the SDK, the smoke bot) can rely on:

- **One typed envelope shape covers every channel.**
- **Request/response channels are correlated by `requestId`.** No
  out-of-band response correlation.
- **IPC envelope round trip (child → parent → child) ≤ 5 ms p99** for
  non-storage channels (see [`subsystems/parent-actor.md`](../subsystems/parent-actor.md)).
- **Storage-mediated channels** (`state.*`, `blob.*`, `api.invoke`)
  have channel-specific p99s gated by the underlying I/O.
- **Channel names are exhaustive** — the parent's switch statement
  rejects unknown channel names; the child's runtime adapter never
  emits names outside the catalog.

## Cross-references

- [`@pax-backend/ipc-protocol`](../../shared/ipc-protocol/) —
  TypeScript source of truth
- [`contract/creator-runtime.md`](../contract/creator-runtime.md) —
  what the bundle sees
- [`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md) —
  lifecycle payload semantics
- [`contract/storage.md`](../contract/storage.md) — storage tier
  contract
- [`contract/external-api-channel.md`](../contract/external-api-channel.md) —
  `c.api.invoke` semantics
- [`contract/compute-budgets.md`](../contract/compute-budgets.md) —
  budget names + error codes
- [`subsystems/parent-actor.md`](../subsystems/parent-actor.md) —
  parent-side dispatch
- [`subsystems/child-runner-sandbox.md`](../subsystems/child-runner-sandbox.md) —
  child-side runtime adapter
- [`vision/trust-model.md`](../vision/trust-model.md) — untrusted-child
  threat model
- [`event-schema.md`](event-schema.md) — what these channels record into
  history
- [`error-codes.md`](error-codes.md) — full error taxonomy
