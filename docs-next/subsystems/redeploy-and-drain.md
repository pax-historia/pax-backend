# Redeploy and drain

> Layer: **Subsystem**

Three independently-deployable surfaces, three cadences, three player-visible-effect profiles.

## Purpose

Land changes to the substrate continuously without breaking running
games. The substrate commits to specific drain semantics on each surface
so that mid-deploy traffic always has a correct execution path.

## The three deploy surfaces

| Surface | What ships | App | Cadence | Player-visible effect |
|---|---|---|---|---|
| **Orchestration** | Placement router, control plane, API gateway, first-party URL services | `pax-backend-control` | Multiple per day | None — orchestration isn't in the WS data path |
| **Shard image** | Runtime: Broker + Runner pool | `pax-backend-shards` | Daily to weekly | None on planned drain (zero loss); brief reconnect on unplanned shard loss |
| **Creator bundle** | A new bundle binary uploaded via admin REST + bundle pointer flip per game | n/a (data, not code) | Multiple per minute per creator | Brief — game wakes onto new bundle on next reconnect or planned re-wake |

The substrate **owns the safety properties of each redeploy path**. The
vercel backend triggers redeploys (uploads, flips, drains) but never has
to worry about the underlying data-plane semantics.

## Surface 1: orchestration redeploy

Behavior:

- Rolling deploy behind shared Fly hostnames (router, control plane,
  gateway, reference URL services are co-located on `pax-backend-control`
  in v1).
- No game's WS connection traverses orchestration — the WS path is
  client → Broker. So zero player-visible effect for in-flight games.
- In-flight admin REST requests are drained briefly; the vercel backend
  retries on transient 503.
- Reference URL services drain in-flight HTTP requests; the gateway's
  `providerError` mapping covers the rare timing miss.

Player-visible effect: **none**.

Vercel-backend-visible effect: **transient elevated latency on admin REST
during the rolling restart window (typically <30 seconds)**.

## Surface 2: shard image redeploy

This is the substrate's most subtle deploy. Two patterns:

### Canary

- Deploy the new shard image to one shard machine. Watch metrics for
  10–30 minutes.
- New games may be placed on this shard if it's eligible.
- Existing games on other shards are unaffected.

### Rolling drain-and-replace

```
1. Choose a shard to drain (e.g. shard-3).
2. Vercel backend (or substrate operator) calls POST /admin/shards/shard-3/drain.
3. Substrate sets shard-3's acceptingWakes=false in Redis.
4. Placement router stops sending new placements to shard-3.
5. Each game on shard-3 sleeps naturally when its players disconnect (after the 60s sleep-grace).
6. On wake (player reconnect), the router picks a different shard.
   - The new shard's Broker materializes the game's state root from Tigris.
   - onWake fires with reason: 'cold-restart-from-storage'.
   - Zero data loss (the previous sleep checkpointed before release).
7. When shard-3 reports zero active games, the substrate emits shard.drain.completed.
8. The shard is replaced with the new image.
9. Repeat for the next shard.
```

When shards on contract `N` and `N+1` coexist during the rollout:

- Bundles with `runtimeContractRequired: N+1` only place on N+1 shards
  (guarantee #16 placement gate).
- Bundles with `runtimeContractRequired ≤ N` place on either.
- Operators do **not** need to time bundle flips around shard rollouts —
  the placement gate handles it.

Player-visible effect on each drained game: **a brief reconnect when
the player rejoins after the drained shard has released their game**.
For games whose players are connected continuously, the migration
happens on the *next* sleep+wake cycle, which from the player's side
is invisible (the game was asleep at that moment).

### Unplanned shard loss

If a shard machine dies unexpectedly:

- Games on that shard lose at most one checkpoint interval of writes.
- On reconnect, the placement router picks a different shard.
- `onWake` fires with `cold-restart-from-storage`.
- The bundle reads the last committed checkpoint and proceeds.

Player-visible effect: **a brief reconnect plus possible loss of the
last few seconds of game state**. Guarantee #11 sets the upper bound.

## Surface 3: creator bundle redeploy

```
1. Vercel backend pre-checks the new bundle's compat-tag coverage:
   GET /admin/games/:id/bundle-compat?bundleName=new-bundle
   → 200 { ok: true } or 409 { blobCompatTag, bundleCompatTagsAccepted }
2. If 200: ready to flip. If 409: need to bridge through an intermediate
   bundle (vercel backend tooling decides).
3. Vercel backend uploads the new bundle:
   POST /admin/bundles/:bundleName
   (substrate validates manifest, stores binary in Tigris)
4. Vercel backend flips the pointer for one or many games:
   POST /admin/games/:id/bundle { newBundleName }
   - Substrate runs the flip gate (guarantee #15).
   - On 409, the vercel backend doesn't flip that game.
   - On 200, the substrate atomically updates the pointer and stores
     a rollback backup (7-day TTL).
5. The next wake of each flipped game runs the new bundle.
   - onWake fires with reason: 'upgrade'.
   - blobCompatTag !== bundleCompatTag → bundle's onWake migrates the blob.
   - After the next successful sleep, blobCompatTag is updated to the new tag.
```

Per-game heterogeneity is supported by default. A "fleet-wide bundle
update" is host-side iteration over `POST /admin/games/:id/bundle`. Some
games may flip and others may refuse (409); the vercel backend's tooling
decides whether to bridge them through an intermediate bundle or leave
them on the old pointer.

Player-visible effect: **the bundle's `onWake` runs migration code, which
may take a few extra seconds on the first wake after the flip**. After
that, the new bundle behaves normally.

### Bundle rollback (automatic)

If `onWake` on the new bundle fails N consecutive times (default 3),
the control plane:

1. Reads the rollback backup.
2. Atomically restores the previous bundle pointer.
3. Emits `bundle.rollback.thresholdReached` then `bundle.rollback`.
4. Re-wakes the game's isolate on the previous bundle.

Player-visible effect: **a brief reconnect; the game is back on the old
bundle.** No data loss (the failed bundle's `onWake` would have aborted
before writing).

## The drain state machine

```
            ┌────────────────────────┐
            │ healthy / acceptingWakes│
            └───────────┬────────────┘
                        │
                        │ POST /admin/shards/:id/drain
                        ▼
            ┌────────────────────────┐
            │ draining / acceptingWakes=false │
            └───────────┬────────────┘
                        │
                        │ Each game on the shard sleeps naturally
                        │ (sleep-grace expires); released to Tigris-canonical
                        ▼
            ┌────────────────────────┐
            │ drained / 0 active games │
            └───────────┬────────────┘
                        │
                        │ Shard replaced with new image, OR
                        │ DELETE /admin/shards/:id/drain (un-drain)
                        ▼
            ┌────────────────────────┐
            │ healthy / acceptingWakes│
            └────────────────────────┘
```

The drain endpoint returns 202 immediately. The vercel backend (or
substrate operator) polls `GET /admin/shards/:id` for the current state
or tails history for `shard.drain.completed`.

## Trust position

**Platform-trusted.** Drain and bundle-flip operations require admin
bearer token.

## Observability surface

| Signal | Notes |
|---|---|
| History events: `shard.drain.started`, `shard.drain.completed`, `bundle.uploaded`, `bundle.flip.succeeded`, `bundle.flip.refused`, `bundle.rollback.*` | Control plane writer |
| Metrics: `pax_control_shard_drain_duration_seconds`, `pax_control_bundle_flip_total{result}`, `pax_broker_cold_restart_from_storage_total` | Per-surface |

## End-state contract

- **Orchestration redeploys never affect in-flight WS sessions.**
- **Shard drains lose zero data** on planned drain (per guarantee #11).
- **Shard machine loss loses ≤ one checkpoint interval of writes** (per guarantee #11).
- **Bundle flips are atomic** — the pointer is updated or not; partial
  states are impossible.
- **Rollback fires within the threshold** after N consecutive
  `onWake.failed` events (guarantee #13).

## Cross-references

- [`vision/guarantees.md`](../vision/guarantees.md) #11, #13, #15, #16
- [`contract/bundle-compatibility.md`](../contract/bundle-compatibility.md) — flip gate
- [`control-plane-admin-api.md`](control-plane-admin-api.md) — drain + flip endpoints
- [`bundle-storage.md`](bundle-storage.md) — bundle upload pipeline
- [`broker.md`](broker.md) — checkpoint-before-release on drain
- [`placement-and-wake.md`](placement-and-wake.md) — placement under drain
