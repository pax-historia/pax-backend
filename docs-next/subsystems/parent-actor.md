# Parent actor

> Layer: **Subsystem**

The parent actor is the substrate's most load-bearing component. One
parent actor process runs per game (as a Rivet actor) and hosts a single
child process containing the bundle. The parent owns transport,
sessions, IPC, compute budgets, history, and storage cache.

## Purpose

For each game:

- Accept WS connections from authorized players.
- Generate `sessionId`s and track session lifecycles.
- Fork and supervise the child process.
- Broker IPC between the child and the rest of the substrate (gateway,
  storage, history sink).
- Enforce compute budgets.
- Write history events.
- Manage the `c.state` cache and Tigris flush window.
- Handle planned/unplanned wake, sleep, eviction, restart, and
  cross-shard migration.

## Owns

- The WS server endpoint on its shard.
- Session generation (`sessionId` uniqueness).
- Idempotent player input (`(playerId, seq)` deduplication).
- The IPC envelope to/from the child (see
  [`reference/event-schema.md`](../reference/event-schema.md) for the
  channel list).
- All eight compute budget enforcers except `api-invocations-per-min`
  (which is at the gateway).
- The `c.state` in-process cache + flush scheduler.
- The history JSONL writer (per-shard local file; Vector ships to
  Tigris).
- The bundle binary fetch (from Tigris on cold wake; cached locally).
- Capacity push to Redis every 2 seconds.

## Doesn't own

- The placement decision (router).
- The kind→URL registry (gateway).
- Bundle storage management (control plane).
- Admin REST endpoints (control plane).
- The child's internal JavaScript (untrusted; sandboxed).

## Inputs

| Source | What |
|---|---|
| Vercel platform frontend wrapper | WS connections (with substrate-signed JWT) |
| Control plane | Bundle pointer updates, allowed-player mutations (via Redis), drain flags, host events |
| Child process | IPC envelopes for `state.*`, `blob.*`, `ws.send`, `log.emit`, `metrics.emit`, `api.invoke`, `lifecycle.requestSleep`, `compute.budget`, `players.*` |
| Tigris | `c.state` reads/writes, `c.blob` ops, bundle binary fetch |
| API gateway | `c.api.invoke` responses |
| Redis | Active-game directory state, allowed-players sets, drain flags |

## Outputs

| Destination | What |
|---|---|
| Vercel platform frontend wrapper | WS messages from the bundle's `c.ws.send` |
| Child process | IPC envelopes for `onWake`, `onSleep`, `onPlayerConnect`, `onPlayerDisconnect`, `onPlayerMessage`, `onCapacityWarning`, `onHostEvent`, plus IPC responses to child requests |
| API gateway | `c.api.invoke` requests |
| Tigris | `c.state` flushes, `c.blob` writes |
| Redis | Capacity push, session metadata |
| History sink (Tigris via Vector) | Every event |

## The IPC channel set

Channels are typed messages over Node's `child_process` IPC. Two
directions. The exhaustive envelope and payload reference lives in
[`reference/ipc-protocol.md`](../reference/ipc-protocol.md); the
summary below is for quick orientation.

### Child → Parent

| Channel | Purpose |
|---|---|
| `api.invoke` | Call an URL service kind |
| `state.read` / `state.write` / `state.flush` | `c.state` ops |
| `blob.put` / `blob.get` / `blob.delete` / `blob.list` | `c.blob` ops |
| `ws.send` | Send a WS message |
| `players.allowed` / `players.connected` | Read session/roster snapshots |
| `compute.budget` | Read current compute snapshot |
| `log.emit` / `metrics.emit` | Observability emissions |
| `lifecycle.requestSleep` | Voluntary sleep request |
| `lifecycle.sleepComplete` | Bundle signals it's done flushing in `onSleep` |
| `child.handlerComplete` / `child.handlerError` | CPU enforcement telemetry |
| `child.fatal` | Child caught an uncaught error |

### Parent → Child

| Channel | Purpose |
|---|---|
| `bootstrap` | One-time startup payload (bundle source, manifest, test seed, budget config) |
| `onWake` / `onSleep` / `onPlayerConnect` / `onPlayerDisconnect` / `onPlayerMessage` / `onCapacityWarning` / `onHostEvent` | Lifecycle dispatch |
| `*.response` | Response to a child→parent request |

Every IPC envelope carries `version`, `type`, `requestId?`, `traceId?`,
`spanId?`, `ts_ns?`, and `payload`. The version field is the
runtime contract version (the IPC envelope shape itself is governed by
that).

## Session lifecycle

```
1. WS handshake arrives on the parent's WS endpoint.
2. Parent verifies the JWT using PAX_JWT_SECRET.
3. Parent extracts (gameId, playerId, traceId, runId?) from JWT claims.
4. Parent verifies the token's gameId matches the actor key selected by the WS URL.
5. Parent looks up allowed-players for gameId.
6. If playerId ∉ allowedPlayers: close WS with 4403 + emit connection.refused.
7. Else: generate a fresh sessionId; emit session.opened.
8. If no child is running for this game: fork child, send bootstrap, wait for ready, send onWake.
9. Send onPlayerConnect to the child.
10. For each incoming WS message: generate seq; emit onPlayerMessage; send to child.
11. On WS close: emit session.closed with reason.
12. If last session: start 60s sleep-grace timer.
13. On grace expiry: send onSleep with deadline = now + budget.
14. After lifecycle.sleepComplete (or deadline): flush c.state, terminate child, emit lifecycle.sleepComplete.
```

## The `c.state` cache and flush scheduler

The parent maintains a per-game `c.state` cache. On bundle write:

```
1. Update cache (synchronous).
2. Mark cache dirty.
3. Schedule a flush to Tigris within the configured flush window (default 1s).
4. Return { ok: true } to the bundle.
```

On flush window expiry (or `c.state.flush()` call):

```
1. Acquire flush lock.
2. CBOR-serialize the cached value.
3. PUT to Tigris at state/<gameId>.cbor.
4. On success: clear dirty flag, emit state.flush event.
5. On failure: retry with backoff (3 retries); if still failing, emit storage.unavailable and surface.
```

On planned sleep/drain/migration:

```
1. Cancel the scheduled flush (if any).
2. Synchronously flush any dirty state.
3. Wait for the flush to complete.
4. Only then release the game.
```

This is the guarantee #11 implementation: planned transitions lose
nothing.

## Compute budget enforcement

For each budget:

| Budget | Where the parent checks |
|---|---|
| `cpu-ms-per-tick` | Wraps the child's handler invocation with a timeout; on timeout, kills the handler (not the child) |
| `memory-bytes` | Polls child RSS every 1s; on overrun, kills the child and restarts with `cold-restart-after-crash` |
| `bandwidth-bytes-per-sec` | Sliding-window counter on outbound `c.ws.send` bytes |
| `ws-messages-per-sec` | Sliding-window counter on outbound `c.ws.send` calls |
| `state-bytes` | Pre-check on `c.state.write` |
| `blob-bytes` | Pre-check on `c.blob.put` |
| `blob-keys` | Pre-check on `c.blob.put` (counts distinct keys in the namespace) |
| `api-invocations-per-min` | **Delegated to gateway**; parent forwards every `c.api.invoke` and the gateway pre-checks |

Over-budget rejections come back to the bundle as typed errors per
[`reference/error-codes.md`](../reference/error-codes.md). The parent
also emits `compute.budget.rejected` history events.

`onCapacityWarning` fires when usage crosses 80% of any budget (best
effort).

## Cross-shard migration

When the control plane marks a shard as draining, or when capacity
pressure requires rebalancing:

1. The parent receives a "migrate" command via Redis.
2. Sends `onSleep` to the child with `reason: 'shardEvicted'` and a
   30s deadline.
3. After `lifecycle.sleepComplete` (or deadline), flushes `c.state` to
   Tigris.
4. Terminates the child.
5. Releases the game from the active-game directory.
6. The placement router picks a different shard on next wake.
7. The new shard's parent reads `c.state` from Tigris, sends `onWake`
   with `cold-restart-from-storage`.

Because Tigris is canonical, no data movement is needed between shards.
Cross-shard migration is observably identical to wake.

## Trust position

**Shard-local-trusted.** The parent is a substrate-owned process running
on the shard machine — implemented as a Rivet actor in v1 (see
[`why/why-rivet-vendored.md`](../why/why-rivet-vendored.md)). It holds
shared shard credentials (Tigris S3 keys, Redis URL) but not per-game
scoped ones. If compromised, ~100 games on this shard are affected. See
[`vision/trust-model.md`](../vision/trust-model.md).

The parent treats the child as **untrusted**. Every IPC envelope is
validated:

- Channel name must be in the enumerated set.
- Payload shape must match the channel's schema.
- `gameId` is stamped by the parent, not taken from the child.
- `sessionId` is stamped by the parent, not taken from the child.
- Compute budget counters are tracked from the parent's side.

## Observability surface

| Signal | Notes |
|---|---|
| Metrics: `pax_parent_*` (frame_age_seconds, ipc_age_seconds, broadcast_duration, handler_duration, event_loop_lag, compute_budget_consumed_ratio, child_lifecycle_total, api_invoke_duration) | Prometheus `:7700/metrics` |
| Traces: `parent.ws_accept`, `parent.session`, `parent.on_player_message`, `parent.broadcast`, `parent.api_invoke`, `parent.handler.*` | OTLP |
| Logs: structured JSON via `pino` | stdout → Vector |
| History events: virtually all substrate events except placement and admin events | Per-shard `var/history.jsonl` → Vector → Tigris |

## End-state contract

- **IPC envelope round trip (child→parent→child) ≤ 5 ms p99** for non-storage channels.
- **`c.state` cache reads are synchronous** (no I/O).
- **Planned-transition flushes complete before release.**
- **`pax_seq` is gap-free per shard across restart.**
- **No `parent.crash` history events under normal operation.** Any
  surfaces an alert.

## Cross-references

- [`contract/creator-runtime.md`](../contract/creator-runtime.md) — `c.*` surface
- [`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md) — hook
  contract
- [`contract/storage.md`](../contract/storage.md) — what the parent caches
- [`contract/compute-budgets.md`](../contract/compute-budgets.md) — what the parent enforces
- [`contract/history-events.md`](../contract/history-events.md) — what the parent writes
- [`reference/ipc-protocol.md`](../reference/ipc-protocol.md) — parent-child wire contract
- [`reference/event-schema.md`](../reference/event-schema.md) — history schema
- [`reference/jwt-claims.md`](../reference/jwt-claims.md) — JWT the parent verifies on WS accept
- [`vision/guarantees.md`](../vision/guarantees.md) — most guarantees touch the parent
- [`why/why-rivet-vendored.md`](../why/why-rivet-vendored.md)
- [`child-runner-sandbox.md`](child-runner-sandbox.md)
