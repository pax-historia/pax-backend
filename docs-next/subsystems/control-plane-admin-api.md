# Control plane and admin API

> Layer: **Subsystem**

The control plane is the substrate's mutation-and-introspection surface.
The vercel backend talks to it for every game/bundle/shard/player/kind
operation that doesn't go over WS or through the gateway.

## Purpose

Implement the admin REST API. Coordinate cross-component operations
(bundle flips, host events, drains, history reads, time-travel restore).
Be the canonical writer of substrate-level history events that don't fit
cleanly inside the Broker.

## Owns

- The admin REST surface (all endpoints in
  [`reference/admin-api.md`](../reference/admin-api.md)).
- Bundle storage coordination (Tigris uploads + Redis manifest
  metadata). See [`bundle-storage.md`](bundle-storage.md).
- The flip gate (guarantee #15 flip-side) — `compatTagOutOfRange` 409
  on `POST /admin/games/:id/bundle`.
- The bundle upload validation gate — `400 manifestInvalid` on
  malformed manifests.
- The host-event admin endpoint (`POST /admin/games/:id/host-event`)
  including the durable queue + wake-on-delivery wiring.
- The 7-day rollback backup that gets created on every successful flip.
- The history read API (`GET /admin/history` with cursor pagination
  over Tigris).
- The shard registry and drain coordination.
- The admin bearer token verification.

## Doesn't own

- Game lifecycle on a shard (Broker).
- The runtime bridge to the isolate (Broker).
- Outbound URL service calls (api-gateway).
- Placement decisions (placement-router).
- Bundle code execution (Runner isolate).

## Inputs

| Source | What |
|---|---|
| Vercel backend | Every admin REST call (game/bundle/shard/player/kind operations, host events, history reads, time-travel) |
| Brokers | Capacity pushes (via Redis); history append (via Tigris) |
| Tigris | Bundle binaries, history archives, game state root + versions (for snapshot / time-travel endpoints) |
| Redis | Active-game directory, allowed players, bundle metadata, drain flags |

## Outputs

| Destination | What |
|---|---|
| Vercel backend | Admin REST responses + history stream |
| Placement router | Wake triggers (for `wakeOnDelivery` host events) — internal RPC or shared Redis |
| Brokers | Bundle pointer updates (via Redis), drain flags (via Redis), allowed-player mutations (via Redis with push semantics — see below) |
| Tigris | Bundle uploads, history archive writes (via Vector) |

## The admin surface, by area

| Area | Endpoints |
|---|---|
| **Games** | `POST /admin/games`, `GET /admin/games/:id`, `DELETE /admin/games/:id`, `GET /admin/games/:id/snapshot` |
| **Bundle flip** | `POST /admin/games/:id/bundle`, `GET /admin/games/:id/bundle-compat?bundleName=…` |
| **Allowed players** | `POST /admin/games/:id/allowed-players/:playerId`, `DELETE /admin/games/:id/allowed-players/:playerId`, `GET /admin/games/:id/allowed-players`, `GET /admin/games/:id/connected-players` |
| **Players (sugar)** | `GET /admin/players/:playerId/games`, `DELETE /admin/players/:playerId` |
| **Compat tag observability** | `GET /admin/games/compat-tags`, `GET /admin/games/by-compat-tag/:tag` |
| **Sessions** | `GET /admin/games/:id/sessions`, `GET /admin/sessions/:sessionId` |
| **Bundles** | `POST /admin/bundles/:bundleName`, `GET /admin/bundles/:bundleName`, `DELETE /admin/bundles/:bundleName` |
| **Shards** | `GET /admin/shards`, `GET /admin/shards/:id`, `POST /admin/shards/:id/drain`, `DELETE /admin/shards/:id/drain` |
| **API kinds** | `POST /admin/api-kinds`, `GET /admin/api-kinds`, `GET /admin/api-kinds/:kindName`, `DELETE /admin/api-kinds/:kindName` |
| **History** | `GET /admin/history` |
| **Host events** | `POST /admin/games/:id/host-event` |

Full request/response schemas live in
[`reference/admin-api.md`](../reference/admin-api.md).

## Critical mechanics

### The flip gate (guarantee #15, flip side)

`POST /admin/games/:id/bundle` with `{ newBundleName }`:

1. Load the game's current `blobCompatTag` (may be undefined if the
   game has never persisted).
2. Load the new bundle's manifest.
3. If `blobCompatTag` is defined and `blobCompatTag ∉
   newBundle.compatTagsAccepted`:
   - Return `409 compatTagOutOfRange` with body
     `{ blobCompatTag, bundleCompatTagsAccepted }`.
   - Emit `bundle.flip.refused` history event.
4. Otherwise:
   - Snapshot the current bundle pointer + game metadata into a
     rollback backup (7-day TTL, keyed by `gameId`).
   - Atomically update the bundle pointer in Redis.
   - Emit `bundle.flip.succeeded`.
   - The next wake of this game will pick up the new bundle.

`GET /admin/games/:id/bundle-compat?bundleName=...` runs the same check
without side effects, returning the would-be 409 body or `{ ok: true }`.

### Bundle upload (`POST /admin/bundles/:bundleName`)

1. Parse the manifest from the upload.
2. Run the manifest validator (
   `compatTagProduced ∈ compatTagsAccepted`,
   `runtimeContractRequired > 0`,
   non-empty strings). On failure: `400 manifestInvalid`.
3. Refuse if a Redis index row already exists for the bundle name
   (write-once; the Redis row is the source of truth for existence).
4. Refuse if the bundle name violates the immutability/monotonicity
   policy (see [`bundle-storage.md`](bundle-storage.md)).
5. Upload the binary bytes to Tigris at the bundle's canonical path.
6. **Finalize**: write the manifest row to Redis. This single commit is
   the moment the bundle becomes visible to placement, flip, and fetch.
7. Emit `bundle.uploaded`.

The substrate writes Tigris first and finalizes via Redis because
Tigris and Redis are independent stores; see
[`bundle-storage.md`](bundle-storage.md) §"Cross-store commit model"
for the recoverable-finalize pattern and the orphan-cleanup sweep.

### Host events (`POST /admin/games/:id/host-event`)

Body: `{ eventType: string, payload: unknown, wakeOnDelivery?: boolean }`.

- **`wakeOnDelivery: false` (default)**:
  - If the game is awake (the Broker holds a live isolate for it):
    forward the event via the Broker's host-event channel.
    Best-effort; emit `onHostEvent.delivered` or drop quietly.
  - If asleep: drop. No history event other than `onHostEvent.dropped`
    if we want to record it.

- **`wakeOnDelivery: true`**:
  - Persist the event in a per-game durable queue (Redis with TTL=30
    days).
  - If asleep: trigger a placement via the router; on wake, the Broker
    drains the queue and delivers each event via `onHostEvent`.
  - If awake: drain the queue immediately.
  - Each delivery emits `onHostEvent.delivered` with the
    `(eventType, payload)`; guarantee #17 oracle reads this.

### Drain (`POST /admin/shards/:id/drain`)

1. Set the shard's `acceptingWakes` flag to false in Redis.
2. Wait for outstanding checkpoints (the Broker reports on its capacity
   push when all games have been checkpointed and released).
3. Emit `shard.drain.started`.
4. The placement router stops sending new placements to this shard.
5. Existing games naturally migrate as their sleep-grace expires;
   on next wake they get a fresh shard via the router's normal
   placement flow (the old shard's `acceptingWakes: false` removes it
   from the eligible set).
6. When the Broker reports zero active games and zero pending
   checkpoints, emit `shard.drain.completed`.

`DELETE /admin/shards/:id/drain` un-drains (clears the flag).

### `removeAllowedPlayer` and force-disconnect

`DELETE /admin/games/:id/allowed-players/:playerId`:

1. Remove the player from the allowed-players set in Redis.
2. Notify the Broker (via Redis pub-sub or a direct HTTP push) to
   force-disconnect any session for this player on this game.
3. The Broker emits `session.forceDisconnect` events for affected
   sessions.
4. Return 200 OK with **the response held** until the Broker
   acknowledges all disconnects, OR
   return 202 Accepted immediately and let the caller poll
   `GET /admin/games/:id/connected-players` to confirm.

The design commits to **the push-with-202 variant**: the admin endpoint
publishes the mutation, returns 202, and the Broker processes it within
500 ms p99. The vercel backend's UI updates after the
`session.forceDisconnect` event lands in history (it's tailing).

This commits to push semantics, not poll. (Distinct from the
README-era poll-every-5s implementation.)

### `DELETE /admin/players/:playerId`

Atomic across all games the player is allowed in:

1. List all `gameId`s containing this `playerId` in their allowed-set.
2. For each, run `removeAllowedPlayer` (same push mechanism).
3. Emit `player.deleted` to history.
4. Return 202.

No billing state is touched — the substrate has none. If the vercel
backend's billing system needs to zero balances or block top-ups, it
does that separately.

## Bundle rollback

When the Broker reports N consecutive `onWake.failed` events for a new
bundle (default N=3), the control plane:

1. Reads the rollback backup (created at flip time).
2. Atomically restores the previous bundle pointer.
3. Emits `bundle.rollback.thresholdReached` then `bundle.rollback`.
4. Notifies the Broker to re-wake the game's isolate on the previous
   bundle.

If the backup is older than 7 days, rollback fails with
`bundle.rollback.expired` and a human operator must intervene.

## Trust position

**Platform-trusted.** The control plane holds the admin bearer token
and writes bundle binaries to Tigris. Compromise = substrate
compromise.

## Observability surface

| Signal | Owner |
|---|---|
| Metrics: `pax_control_*` (admin call duration, flip-gate rejections, host-event delivery) | Self; `:9070/metrics` |
| Logs: structured JSON | Self → stdout → Vector |
| Traces: OTel spans `control.<endpoint>` | Self → OTLP → Vector |
| History writes: bundle/game/shard/player/flip/rollback events | Self |

## End-state contract

- **Admin REST p99 latency ≤ 200 ms** for non-snapshot endpoints under
  steady-state load.
- **Snapshot endpoints (`GET /admin/games/:id/snapshot`)** may take longer
  if the game uses a large `c.blob` namespace; supports `?includeBlob=false`
  to skip. `?at=<checkpointSeq>` resolves a past checkpoint (time travel).
- **History pagination is cursor-stable**: the same `cursor` always
  returns the same page (idempotent re-read).
- **Bundle uploads are recoverable.** The Redis index commit is the
  visibility point; interrupted uploads leave Tigris orphans, which the
  GC sweep cleans up. See [`bundle-storage.md`](bundle-storage.md)
  §"Cross-store commit model".
- **Host-event `wakeOnDelivery: true` is at-least-once** within 30-day
  TTL (guarantee #17).

## Cross-references

- [`reference/admin-api.md`](../reference/admin-api.md) — full endpoint
  catalog
- [`bundle-storage.md`](bundle-storage.md) — bundle upload pipeline
- [`broker.md`](broker.md) — Broker ↔ control plane interactions
- [`state-store.md`](state-store.md) — time-travel restore mechanics
- [`placement-and-wake.md`](placement-and-wake.md) — host-event wake
  handoff
- [`vision/guarantees.md`](../vision/guarantees.md) #15, #17
