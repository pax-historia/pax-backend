# Broker

> Layer: **Subsystem**

The Broker is the substrate's most load-bearing component. **One Broker
process runs per shard.** It holds every credential and all identity
authority, terminates WebSockets, owns sessions and the eight compute
budgets, runs the per-game state cache and atomic checkpoint flush to
Tigris, is the sole egress to the gateway and Redis, and decides
capacity and eviction. Everything trusted on a shard lives here; the
Runners that execute creator code hold nothing.

## Purpose

For each shard:

- Terminate player WebSocket connections and verify their JWTs.
- Generate `sessionId`s and track session lifecycles.
- Stamp identity (`gameId`, `sessionId`, `connectedSessions`) onto every
  `c.*` request from a Runner — never trust the Runner's claims.
- Place games onto Runners, supervise the Runner pool, and enforce
  capacity / eviction watermarks.
- Enforce compute budgets.
- Run the per-game state cache + checkpoint scheduler (the
  [`state-store.md`](state-store.md) engine) and be the sole writer to
  Tigris.
- Proxy `c.api.invoke` to the gateway; write history.
- Handle planned/unplanned wake, sleep, eviction, restart, and
  cross-shard migration.

## Owns

- The shard's WS server endpoint (a mature library — `ws` or
  `uWebSockets.js`) and JWT verification on upgrade.
- Session generation (`sessionId` uniqueness) and idempotent player input
  (`(playerId, seq)` dedup).
- The Runner pool: process supervision, game→Runner assignment, and the
  one async channel per Runner.
- All eight compute budget enforcers except `api-invocations-per-min`
  (at the gateway).
- The per-game `c.state` / `c.blob` cache + checkpoint scheduler, and the
  Tigris credentials.
- The history JSONL writer (per-shard local file; Vector ships to Tigris).
- The bundle binary fetch (from Tigris on cold wake; cached locally),
  handed to Runners as source.
- Capacity push to Redis (watermark-aware) and the active-game directory
  claim for games it hosts.
- All shard credentials: Tigris S3 keys, Redis URL, the JWT secret,
  URL-service auth.

## Doesn't own

- The placement decision across shards (router).
- The kind→URL registry (gateway).
- Bundle storage management (control plane).
- Admin REST endpoints (control plane).
- The creator JavaScript itself (untrusted; runs in a Runner's isolate).

## Inputs

| Source | What |
|---|---|
| Vercel platform frontend wrapper | WS connections (substrate-signed JWT), pinned to this machine by the Fly proxy |
| Control plane | Bundle pointer updates, allowed-player mutations (via Redis), drain flags, host events |
| Runner | `c.*` requests for assigned games: `state.*`, `blob.*`, `ws.send`, `log.emit`, `metrics.emit`, `api.invoke`, `lifecycle.requestSleep`, `compute.budget`, `players.*`; plus handler telemetry and per-isolate counters |
| Tigris | `c.state` / `c.blob` materialize and checkpoint commits, bundle binary fetch |
| API gateway | `c.api.invoke` responses |
| Redis | Active-game directory state, allowed-players sets, drain flags |

## Outputs

| Destination | What |
|---|---|
| Vercel platform frontend wrapper | WS messages (the bundle's `c.ws.send`, fanned out Broker-side) |
| Runner | `onWake`, `onSleep`, `onPlayerConnect`, `onPlayerDisconnect`, `onPlayerMessage`, `onCapacityWarning`, `onHostEvent`, plus responses to Runner requests |
| API gateway | `c.api.invoke` requests |
| Tigris | Checkpoint commits (state objects + root PUT) |
| Redis | Capacity push (with watermark state), session metadata, directory claim |
| History sink (Tigris via Vector) | Every event |

## The three rings of access

The Broker is the top of three rings, each with strictly less power than
the one above (full threat model in
[`vision/trust-model.md`](../vision/trust-model.md)):

1. **Isolate (untrusted creator JS):** holds nothing — no network, fs,
   env, credentials — only the `c.*` surface; cannot see sibling isolates.
2. **Runner (credential-less):** no credentials, no network. Its only
   capability is "ask the Broker to act on a game I'm assigned." It does
   **not** assert identity the Broker trusts.
3. **Broker:** the sole holder of Tigris/Redis keys, the JWT secret, and
   URL-service auth, and the sole network egress and identity authority.

This is why the Broker stamps `gameId` / `sessionId` / `connectedSessions`
from its own session state and **rejects any RPC for a game a Runner is
not assigned**. The Runner being credential-less is load-bearing and
non-negotiable: a full native escape inside a Runner reaches only the
low-value content of its co-tenant games, no credential.

## WebSocket transport

The WS protocol is a solved problem; the Broker uses a mature library and
does not reinvent it:

- **Termination:** `ws` (tens of thousands of connections/process) or
  `uWebSockets.js` (hundreds of thousands, with built-in pub/sub for
  fan-out). The Broker verifies the JWT on upgrade, maps the connection to
  its `gameId`, and dispatches frames to the right Runner/isolate — a flat
  in-memory lookup, not distributed routing.
- **Machine routing:** the placement router returns a shard-specific
  `webSocketUrl` + signed JWT, so "which shard" is decided before the
  socket opens; the Fly proxy (`fly-replay`) pins the connection to the
  target machine. See [`reference/ws-subprotocol.md`](../reference/ws-subprotocol.md).
- **Fan-out is Broker-side.** The bundle calls `c.ws.send("all", body)`
  **once**; the Broker fans out to the N sockets (e.g. `uWebSockets.js`
  topic pub/sub). The isolate's per-broadcast cost is O(1) + one
  serialization; the O(N) socket writes are the Broker's, on native code.
- **Operational checklist:** backpressure (`bufferedAmount`/drain →
  bandwidth budget), heartbeats + dead-connection reaping (→ `timedOut`
  disconnect), fd limits, LB idle timeouts, per-process connection caps.

## The Broker ↔ Runner bridge

In-memory IPC (local socket / pipe), async, **one channel per Runner**.
~1M+ small messages/sec and GB/s capacity; realistic shard load ~10k
messages/sec, ~1% utilization. Compute/bandwidth-bound, never disk- or
lock-bound. Three hard rules keep it that way:

1. **No durable disk on the hot path.** `c.state.write` returns from the
   cache; the Tigris checkpoint is async and batched. Nothing fsyncs
   between a player message and the response.
2. **Per-Runner channels.** No single thread funnels the whole shard.
3. **Do not re-copy large payloads.** Small messages copy fine; large
   blob transfer copies through the channel to the blob cap, with a tmpfs
   path handoff only if profiling demands it.

The Broker stamps identity and validates assignment on every request. The
wire contract (both boundaries) is
[`reference/ipc-protocol.md`](../reference/ipc-protocol.md).

## Session lifecycle

```
1. WS upgrade arrives on the Broker's WS endpoint (Fly-proxy-pinned to this machine).
2. Broker verifies the JWT using PAX_JWT_SECRET.
3. Broker extracts (gameId, playerId, traceId, runId?) from JWT claims.
4. Broker verifies the token's gameId matches the shard it was routed to.
5. Broker looks up allowed-players for gameId.
6. If playerId ∉ allowedPlayers: close WS with 4403 + emit connection.refused.
7. Else: generate a fresh sessionId; emit session.opened.
8. If no isolate is running for this game: assign to a Runner, deliver bundle source, wait for ready, send onWake.
9. Send onPlayerConnect to the Runner (→ isolate).
10. For each incoming WS message: generate seq; emit onPlayerMessage; send to the Runner.
11. On WS close: emit session.closed with reason.
12. If last session: start 60s sleep-grace timer.
13. On grace expiry: send onSleep with deadline = now + budget.
14. After lifecycle.sleepComplete (or deadline): checkpoint c.state, dispose the isolate, emit lifecycle.sleepComplete.
```

Wake is cheap: **create an isolate + eval the bundle** (no `fork()`, no
Node boot, no workflow hydrate). Sleep is **dispose the isolate +
checkpoint**.

## The state cache and checkpoint scheduler

The Broker runs the [`state-store.md`](state-store.md) engine per hosted
game. On bundle write:

```
1. Update cache (synchronous).
2. Add to the dirty set.
3. Return { ok: true } to the bundle (no Tigris on the hot path).
```

On checkpoint-interval expiry (or `c.state.flush()`):

```
1. If nothing is dirty, return without writing anything (idle is free).
2. Encode changed state (per codec); write any new state/blob versions.
3. Conditional root PUT (If-Match on checkpointSeq) — the atomic commit.
4. Mark clean; schedule GC of superseded versions; emit state.checkpoint.
```

On planned sleep/drain/migration:

```
1. Cancel the scheduled checkpoint (if any).
2. Synchronously checkpoint any dirty game.
3. Wait for the root PUT to commit.
4. Only then release the game.
```

This is the guarantee #11 implementation: planned transitions lose
nothing. The full mechanics (root format, codecs, GC, fencing,
time travel) are in [`state-store.md`](state-store.md).

## Resource model

Memory and CPU are opposite kinds of resource and handled oppositely.

### Memory — declare a cap, reserve on actual

- **Cap** (`isolated-vm` `memoryLimit`, fixed at isolate creation): the
  hard kill line. Set to a generous per-preset upper bound. An unused
  ceiling commits almost no physical RAM (V8 only commits pages it
  touches), so a high cap is cheap and lets a world grow with its players
  without OOM.
- **Reservation** (what admission counts against box RAM): track actual,
  player-scaled usage, not the cap:

  ```
  reservation = baseMemory + perPlayerMemory * connectedPlayers   (clamped to [floor, upperCap])
  ```

  The Broker adjusts the reservation as players join and leave.

- **Admission:** place a game on a Runner only if
  `Sum(reservations) + new ≤ box RAM × headroom-factor`. Caps are
  oversubscribed; reservations are not.

### CPU — measured, not reserved

No hard CPU budget, no CPU cap. The controls are the per-handler timeout
(kills a runaway handler, keeps the game), measured usage via
`isolate.cpuTime`, and generous headroom that absorbs uncorrelated bursts.
A bundle may declare a coarse advisory "runs hot" hint to seed placement;
it is never trusted as a cap.

## Capacity, pressure, and eviction

> Relieve a pressured box in the way that puts the **fewest connected
> human players on a loading screen**. Steer new games away early (no
> disruption); evict existing games only as a higher-threshold last
> resort; never thrash.

Three watermarks per resource (CPU and memory each get their own):

1. **Admit-stop (low, ~70%):** stop placing *new* games here. Zero
   disruption; does almost all the work.
2. **Evict-start (high, ~90%):** actively shed existing games. Disruptive
   (reconnects), so set high.
3. **Drain-target (middle, ~80%):** when shedding, drain *to here*.

Evict-start is much higher than admit-stop on purpose; between them is a
healthy band where the box stops growing but evicts no one. Hysteresis is
the gap between evict-start and drain-target: shed **once, decisively,
down to the target**, freeing `current - target` in one batch. Memory
watermarks sit lower than CPU because memory growth is sticky.

**Choosing what to shed (greedy, no solver):** rank candidate games by
**disrupted players per unit of pressured resource freed** (lowest first)
and evict down the list until the drain-target is reached. It is a sort +
running sum; it prefers small games and avoids the big multi-player one.

## Compute budget enforcement

| Budget | Where the Broker checks |
|---|---|
| `cpu-ms-per-tick` | Per-handler timeout wraps each isolate handler invocation; on timeout, kills the handler (not the game) |
| `memory-bytes` | Per-isolate cap via `isolated-vm`; reservation tracked player-scaled (see Resource model) |
| `bandwidth-bytes-per-sec` | Sliding-window counter on outbound `c.ws.send` bytes |
| `ws-messages-per-sec` | Sliding-window counter on outbound `c.ws.send` calls |
| `state-bytes` | Pre-check on `c.state.write` |
| `blob-bytes` | Pre-check on `c.blob.put` (if the game uses keyed blob) |
| `blob-keys` | Pre-check on `c.blob.put` (counts distinct keys) |
| `api-invocations-per-min` | **Delegated to gateway**; Broker forwards every `c.api.invoke` |

Over-budget rejections return as typed errors
([`reference/error-codes.md`](../reference/error-codes.md)); the Broker
emits `compute.budget.rejected` history events. `onCapacityWarning` fires
at 80% of any budget (best effort).

## Cross-shard migration

When the control plane marks a shard draining, or capacity pressure
requires rebalancing:

1. The Broker receives a "migrate" command via Redis.
2. Sends `onSleep` to the Runner with `reason: 'shardEvicted'` and a 30s
   deadline.
3. After `lifecycle.sleepComplete` (or deadline), checkpoints the game to
   Tigris (synchronous; zero loss).
4. Disposes the isolate.
5. Releases the game from the active-game directory.
6. The placement router picks a different shard on next wake.
7. The new shard's Broker materializes from Tigris, sends `onWake` with
   `cold-restart-from-storage`.

Because Tigris is canonical, no data moves between shards. Cross-shard
migration is observably identical to wake.

## Trust position

**Shard-trusted.** The Broker is the substrate-owned, credential-holding
process on the shard machine. If compromised, the working set on this
shard (~its hosted games) is affected. It holds shared shard credentials
(Tigris keys, Redis URL, JWT secret), not per-game scoped ones. See
[`vision/trust-model.md`](../vision/trust-model.md).

The Broker treats every Runner as semi-trusted-at-best: it stamps
identity, validates game assignment, enumerates the allowed channel set,
and tracks budgets from its own side.

## Observability surface

| Signal | Notes |
|---|---|
| Metrics: `pax_broker_*` (frame_age, channel_age, broadcast_duration, handler_duration, event_loop_lag, compute_budget_consumed_ratio, checkpoint_*, runner_lifecycle_total, api_invoke_duration); `pax_runner_*` (per-isolate cpu/mem deltas) | Prometheus `:7700/metrics` |
| Traces: `broker.ws_accept`, `broker.session`, `broker.on_player_message`, `broker.broadcast`, `broker.api_invoke`, `broker.checkpoint`, `broker.handler.*` | OTLP |
| Logs: structured JSON via `pino` | stdout → Vector |
| History events: virtually all substrate events except placement and admin events | Per-shard `var/history.jsonl` → Vector → Tigris |

## End-state contract

- **Bridge round trip (isolate→Broker→isolate) ≤ 5 ms p99** for
  non-storage channels.
- **`c.state` cache reads are synchronous** (no I/O).
- **Planned-transition checkpoints commit before release.**
- **`pax_seq` is gap-free per shard across restart.**
- **No `broker.crash` history events under normal operation.** Any
  surfaces an alert.

## Cross-references

- [`runner.md`](runner.md) — the credential-less process that hosts isolates
- [`state-store.md`](state-store.md) — the cache + checkpoint engine
- [`contract/creator-runtime.md`](../contract/creator-runtime.md) — `c.*` surface
- [`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md) — hook contract
- [`contract/storage.md`](../contract/storage.md) — what the Broker caches
- [`contract/compute-budgets.md`](../contract/compute-budgets.md) — what it enforces
- [`reference/ipc-protocol.md`](../reference/ipc-protocol.md) — Broker↔Runner + isolate bridge
- [`reference/jwt-claims.md`](../reference/jwt-claims.md) — JWT verified on WS accept
- [`why/why-broker-runner.md`](../why/why-broker-runner.md)
- [`vision/trust-model.md`](../vision/trust-model.md)
- [`vision/guarantees.md`](../vision/guarantees.md) — most guarantees touch the Broker
