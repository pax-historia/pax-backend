# Lifecycle and wake

> Layer: **Contract**

The substrate calls into the bundle through seven lifecycle hooks. This
page is the exhaustive payload reference and the wake-state machine
diagram.

## The lifecycle hook set

```
                    ┌──────────────────────────────────────────┐
                    │ Game is asleep                           │
                    │ (no isolate; state committed in Tigris)  │
                    └──────────────────┬───────────────────────┘
                                       │
                                       │ Player reconnects, OR
                                       │ host event with wakeOnDelivery
                                       │ OR planned migration
                                       ▼
                    ┌──────────────────────────────────────────┐
                    │ onWake(c, OnWakePayload)                 │
                    │ isolate created + bundle eval'd          │
                    └──────────────────┬───────────────────────┘
                                       │
              ┌────────────────────────┼──────────────────────────┐
              │                        │                          │
              ▼                        ▼                          ▼
   onPlayerConnect            onPlayerMessage            onHostEvent
   onPlayerDisconnect         (per WS message)           (when delivered)
   (per session edge)         onCapacityWarning
                              (best-effort)
                                       │
                                       │ Sleep grace expires (60s after last
                                       │ disconnect), or c.lifecycle.requestSleep,
                                       │ or shard drain, or bundle upgrade
                                       ▼
                    ┌──────────────────────────────────────────┐
                    │ onSleep(c, OnSleepPayload)               │
                    │ bundle flushes; substrate checkpoints    │
                    └──────────────────┬───────────────────────┘
                                       │
                                       │ deadline reached
                                       ▼
                    ┌──────────────────────────────────────────┐
                    │ Game is asleep                           │
                    └──────────────────────────────────────────┘
```

A game's full lifetime is a sequence of `[onWake → ... → onSleep]`
intervals, with the game asleep between them. Cold-start is one such
interval starting from "no state at all." Cross-shard migration is one
such interval ending on shard A and starting on shard B from the same
committed checkpoint (`c.state` and any `c.blob`). Bundle pointer flip is
one such interval ending on bundle X and starting on bundle Y.

## `onWake(c, payload)`

Called once when the game's isolate is created and the bundle is eval'd
(no process fork, no Node boot). The bundle has zero in-memory state at
this point — anything from before is materialized from the last committed
checkpoint and handed in as `state` (plus lazy `c.blob` if used).

`runId` is scenario-only: it carries the scenario-runner's run identifier
when the wake is part of a test run, and is `null` in production. Bundles
that want a per-wake correlation handle should rely on the substrate's
history `pax_seq` window or their own state-stored counter, not `runId`.

```ts
interface OnWakePayload {
  reason: WakeReason;
  runId: string | null;          // scenario-runner runs only; null in production
  bundleName: string;
  bundleCompatTag: string;       // == this bundle's manifest.compatTagProduced
  blobCompatTag?: string;        // undefined on cold-start
  state: unknown | null;         // the one state object, already hydrated
}

type WakeReason =
  | 'cold-start'                       // first wake ever for this gameId
  | 'reconnect'                        // player reconnect during the sleep-grace window
  | 'cold-restart-after-crash'         // isolate died (or its Runner crashed); substrate restarted it
  | 'cold-restart-after-eviction'      // shard reclaimed the slot; substrate replaced elsewhere
  | 'cold-restart-from-storage'        // covers cross-shard migration AND unplanned shard loss
  | 'upgrade';                         // bundle pointer was flipped while asleep
```

### What each reason means

- **`cold-start`**: this `gameId` has never been hydrated. `state` is
  `null`; `c.blob` is empty. `blobCompatTag` is undefined.
- **`reconnect`**: a player disconnected, then reconnected within the
  60s sleep-grace window. The isolate stayed resident the whole time, so
  in-process state is intact. `onWake` is **not** typically called for
  reconnect when the isolate is still resident — this reason fires only
  when the substrate decided to recreate the isolate after disconnect
  (rare; used for "graceful refresh" patterns). For most reconnects, the
  bundle sees `onPlayerConnect`, not `onWake`.
- **`cold-restart-after-crash`**: the isolate died (per-isolate OOM,
  handler crash) or its Runner process crashed. `state` reflects the last
  committed checkpoint — at most one checkpoint interval of writes is
  lost. Includes `errorClass: 'oom' | 'crash' | 'cpuTimeout' | 'unknown'`.
- **`cold-restart-after-eviction`**: the shard chose to evict this game
  (capacity pressure, drain in progress). State reflects the pre-eviction
  checkpoint (zero loss — eviction is planned, so the substrate
  checkpoints before releasing).
- **`cold-restart-from-storage`**: covers both planned cross-shard
  migration (zero loss) and unplanned shard loss (≤ one checkpoint
  interval loss). The substrate doesn't distinguish — the bundle should
  treat both uniformly.
- **`upgrade`**: the bundle pointer was flipped while the game was
  asleep. `blobCompatTag !== bundleCompatTag`; the bundle's own
  migration code in `onWake` reads the old tag and migrates.

### Migration code lives in `onWake`

When `blobCompatTag !== bundleCompatTag`, the bundle owns the migration:

```ts
async onWake(c, { reason, blobCompatTag, bundleCompatTag, state }) {
  if (blobCompatTag === bundleCompatTag) {
    // Same tag; no migration needed.
    return;
  }

  // Migrate from blobCompatTag to bundleCompatTag.
  // The bundle's compatTagsAccepted list guaranteed by the substrate
  // includes blobCompatTag (otherwise wake would have been refused).
  switch (blobCompatTag) {
    case 'historia:v3':
      await migrateV3ToV4(c);
      // fall through
    case 'historia:v4':
      await migrateV4ToV5(c);
      break;
  }
}
```

The substrate stamps `bundleCompatTag` on the next successful sleep.

## `onSleep(c, payload)`

Called when the substrate is about to release the game. The bundle has a
bounded time to flush, write final checkpoints, and return.

```ts
interface OnSleepPayload {
  deadline: number;                    // absolute timestamp (ms since epoch); past = killed
  reason: SleepReason;
}

type SleepReason =
  | 'idle'                            // 60s sleep-grace fired after last disconnect
  | 'requestedBySleep'                // bundle called c.lifecycle.requestSleep()
  | 'evicted'                         // shard evicted this game
  | 'shardEvicted'                    // shard is going away (drain or shutdown)
  | 'shutdown'                        // platform shutdown
  | 'upgrade';                        // bundle pointer was flipped while awake
```

### Deadline semantics

`deadline` is an absolute timestamp. Per guarantee #10, the substrate
gives the bundle at least the documented per-shape minimum (configurable;
default 30s) between the moment `onSleep` is called and the deadline.
If the bundle's `onSleep` returns after the deadline, the substrate
disposes the isolate and keeps the last committed checkpoint.

The bundle should:

1. Persist any pending in-memory work to `c.state` and/or `c.blob`.
2. Call `await c.state.flush()` if waiting for the next checkpoint
   interval isn't acceptable.
3. Optionally `c.ws.send` a goodbye to connected players.
4. Return.

On `idle`, `requestedBySleep`, `evicted`, `shardEvicted`, the substrate
checkpoints the game (state + any blob) after the bundle returns and
before releasing it. Zero loss on these planned transitions
(guarantee #11).

On `shutdown`, same checkpoint-before-release.

## `onPlayerConnect(c, payload)`

Called after the WS handshake completes and the substrate has verified
the JWT and the allowed-players list. The session is live; subsequent
`onPlayerMessage` calls will use the same `sessionId`.

```ts
interface OnPlayerConnectPayload {
  playerId: string;
  sessionId: string;                // substrate-generated; opaque; cluster-wide unique
  jwtClaims: Record<string, unknown>;
  connectedAt: number;              // ms since epoch
}
```

`jwtClaims` is the verbatim claims object from the router-signed WS JWT,
including the `passthrough` block the vercel backend supplied at
placement time (typically Firebase claims, game role hints, etc.). The
substrate forwards `passthrough` verbatim; the bundle reads whatever
Pax-historia stuffs in. See [`reference/jwt-claims.md`](../reference/jwt-claims.md).

## `onPlayerDisconnect(c, payload)`

Called when a WS connection closes, for any reason.

```ts
interface OnPlayerDisconnectPayload {
  playerId: string;
  sessionId: string;
  reason: DisconnectReason;
}

type DisconnectReason =
  | 'left'                           // client closed the WS
  | 'timedOut'                       // server-side WS ping timeout
  | 'removedFromAllowedPlayers'      // vercel backend removed this player
  | 'shardEvicted'                   // shard is going away
  | 'gameDeleted';                   // admin DELETE /admin/games/:id
```

After the last disconnect, the substrate starts the 60s sleep-grace
timer. If no reconnect arrives, `onSleep({ reason: 'idle', ... })` fires.

## `onPlayerMessage(c, payload)`

Called once per WS message from a player.

```ts
interface OnPlayerMessagePayload {
  playerId: string;
  sessionId: string;
  seq: number;                       // per-session monotonic; substrate-assigned
  body: unknown;                     // JSON-parsed; whatever the client sent
}
```

**Idempotency.** No `(playerId, seq)` is ever delivered twice (guarantee
#6). Per-session `seq` starts at 0 on `onPlayerConnect` and increments
on each message.

## `onCapacityWarning(c, payload)`

Best-effort hint that a compute budget is approaching its limit. Use to
shed load gracefully (slow down broadcasts, skip non-essential work).

```ts
interface OnCapacityWarningPayload {
  budget: ComputeBudgetName;
  currentUsage: number;
  limit: number;
}
```

Warning thresholds are configurable per budget. The substrate fires
warnings at 80% by default. See
[`compute-budgets.md`](compute-budgets.md).

## `onHostEvent(c, payload)`

Called when the vercel backend issues `POST /admin/games/:id/host-event`.
The bundle dispatches on `eventType`; the substrate has no opinion on
the event-type namespace.

```ts
interface OnHostEventPayload {
  eventType: string;
  payload: unknown;
  receivedAt: number;
}
```

**Idempotency.** The bundle MUST be idempotent on `(eventType, payload)`
equality, or include its own dedup key inside `payload`. Guarantee #17 is
at-least-once delivery (the substrate may deliver the same event twice
during failure recovery).

### Delivery modes

When the vercel backend POSTs, it can opt into one of two delivery modes:

- **Default (`wakeOnDelivery: false` or omitted)**: best-effort while
  awake; dropped if the game is asleep.
- **`wakeOnDelivery: true`**: durable. Substrate persists the event,
  wakes the game if asleep (via the same path as a player reconnect),
  delivers, and the game returns to sleep naturally after the grace
  window.

`wakeOnDelivery: true` events have a 30-day TTL; events older than that
are dropped with a logged warning.

## Sleep-grace and the alive-iff-connected rule

A game is "alive" (isolate resident in a Runner) only when:

1. At least one player is connected, OR
2. The 60s sleep-grace window after the last disconnect hasn't expired,
   OR
3. A host event with `wakeOnDelivery: true` is being delivered.

There are no other reasons the substrate keeps an isolate resident. The bundle
**cannot** schedule its own future wake (see
[`why/why-no-scheduled-wakeups.md`](../why/why-no-scheduled-wakeups.md))
and games do **not** progress while asleep (see
[`why/why-no-async-games.md`](../why/why-no-async-games.md)).

Long-duration deadlines use the mark-timestamp pattern: write the
`fireAt` to `c.state`, check on every `onWake` and every
`onPlayerMessage`.

## Host events are the one off-connection wake primitive

The substrate has exactly one mechanism for waking a sleeping game when
no player is connected: `POST /admin/games/:id/host-event` with
`wakeOnDelivery: true`. The vercel backend issues this. The substrate
does not expose any other off-connection wake primitive (no `onTimer`,
no `c.schedule.*`, no cron channel to the bundle).

This is by design — see [`why/why-no-async-games.md`](../why/why-no-async-games.md)
and [`why/why-no-scheduled-wakeups.md`](../why/why-no-scheduled-wakeups.md).
Anything that would be a substrate-side scheduled wake is instead a
vercel-backend cron that POSTs a host event.

**v1 stance on host-event rate limits.** The substrate trusts authenticated
host-backend POSTs and does not enforce a host-event rate limit per game
in v1. The vercel backend is platform-trusted; if a future consumer is less
trusted, or operational evidence demands it, a per-game host-event budget
joins the eight compute budgets without breaking the contract. Until then,
the limit is whatever the vercel backend's own cron schedules can produce.

## Wake reasons by triggering condition (cheat sheet)

| Triggering condition | Wake reason |
|---|---|
| First-ever game create | `cold-start` |
| Player reconnect within sleep-grace, isolate still resident | (no `onWake`; bundle sees `onPlayerConnect`) |
| Player reconnect after the isolate was disposed gracefully | `cold-restart-from-storage` (treating sleep + reconnect as a storage round-trip) |
| Isolate OOM/crash/timeout (or its Runner crashes), Broker restarts | `cold-restart-after-crash` |
| Shard evicted the game | `cold-restart-after-eviction` (next wake on different shard) |
| Cross-shard migration (drain, capacity rebalance) | `cold-restart-from-storage` |
| Shard machine died unexpectedly | `cold-restart-from-storage` |
| Bundle pointer flip while asleep | `upgrade` (then next wake from same bundle is `cold-restart-from-storage`) |
| Host event with `wakeOnDelivery: true` delivered to an asleep game | `cold-restart-from-storage` followed by `onHostEvent` |

## See also

- [`storage.md`](storage.md) — what `c.state` and `c.blob` look like on wake
- [`bundle-compatibility.md`](bundle-compatibility.md) — the flip / cold-wake gate
- [`vision/guarantees.md`](../vision/guarantees.md) — #6 (idempotent input), #10 (eviction budget), #11 (state durability), #17 (host event durability)
- [`subsystems/placement-and-wake.md`](../subsystems/placement-and-wake.md) — substrate-side implementation
