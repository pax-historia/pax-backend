# Redeploy runbook

> Stub. The three runbooks expand in step 11 of the plan's kickoff.

Three independently-deployable surfaces, three cadences. See [plan
README](../../README.md) §"Production redeploy strategy".

| Surface | Deploys to | Cadence | Player-visible effect |
|---|---|---|---|
| Orchestration (router / control plane / API gateway / reference URL services) | `pax-backend-control` | Multiple per day | Brief in-flight HTTP request drain on api.invoke; **WS connections are not affected** because the router is not in the WS path |
| Shard image (runtime + vendored Rivet) | `pax-backend-shards` | Daily – weekly | Per-shard drain; the parent-actor flushes every running game's pending `c.state` write to Tigris before releasing it; in-flight games then run to natural sleep on either the same shard or a fresh placement; `c.state` and `c.blob` are canonically in Tigris across the swap (zero loss on planned drain) |
| Creator bundle | object storage + directory flip | Multiple per minute per creator | Existing games finish on old bundle unless creator force-restarts; new placements pick up new pointer |

## Shard drain — the canonical-storage flush handshake

Because `c.state` is Tigris-canonical (see [README](../../README.md)
§"Storage tiers" + guarantee #11), shard drains are not "evict and pray"
events. The control-plane drain (`POST /admin/shards/:id/drain`) signals
each parent-actor on the shard to:

1. Stop accepting new wakes (the router already reads the
   `acceptingWakes=false` heartbeat).
2. For each running game, force-flush the in-process state cache via
   `c.state.flush` (substrate-internal call, not a creator hook). This
   resolves once the Tigris PUT completes for every pending write.
3. ACK the drain request only after every running game's pending writes
   are durable.

After the ACK, in-flight games either sleep naturally (player disconnects
or sleepTimeout fires) or get migrated by the placement router to a new
shard. Either way, the next `onWake` reads from Tigris under
`cold-restart-from-storage` and the bundle sees zero state loss. Unplanned
machine death — power yank, kernel panic, sudden Fly Machine eviction —
still loses at most the configured flush window of writes; that's the only
data-loss path.

To be filled in with player-visible-effect tables for each runbook (per the
plan's todo `expand-redeploy`).
