# Why: Tigris is the canonical store for `c.state` and `c.blob`

> Layer: **Why**

## Considered

Three placements for the per-game persistent state:

1. **Per-shard RocksDB on a Fly Volume.** Each shard machine has a
   volume; `c.state` and `c.blob` live there, replicated nowhere. This is
   the pax-sharded-spike topology.
2. **Per-shard RocksDB plus Tigris archive.** Hot writes go to the
   shard's local RocksDB; periodic snapshots get pushed to Tigris for
   cross-shard recovery.
3. **Tigris-canonical, with an in-process write-through cache.** Writes
   land in an in-process cache and are flushed to Tigris within a
   configurable window. Reads are from the cache. Tigris is the source of
   truth.

We chose option 3.

## Why we said no to options 1 and 2

### Why not option 1 (per-shard RocksDB only)

- **Cross-shard migration is destructive.** If a game is on shard A and
  shard A's volume dies, the game's state is gone. The whole substrate
  topology has to special-case "lost shard" recovery.
- **Sleeping games are shard-pinned.** A game that's been asleep for a
  week is still tied to whatever shard last hosted it. Placement on wake
  is constrained to that shard. Per-shard volume usage grows with
  lifetime game count, not working-set size.
- **Drain is expensive.** To drain a shard, every game on it has to be
  woken, flushed, and re-placed somewhere with the data copied. With 100
  games per shard this is hundreds of round trips of state movement.
- **Per-shard backup story.** Each shard's volume needs its own backup
  pipeline. Tigris already gives us multi-region durability for free.

### Why not option 2 (RocksDB hot + Tigris archive)

- **Two consistency stories.** Hot writes are local; cold reads are from
  Tigris; the substrate has to reconcile them on every wake. Edge cases
  multiply (what if the shard died between hot write and Tigris push?
  what if Tigris pushed but the local RocksDB hadn't yet acked?).
- **Cache invalidation between writers.** With Tigris-canonical there is
  one writer per game (the parent on the shard hosting it); with the
  hybrid, two writers exist with implicit ordering.
- **Backup retention complexity.** Two storage tiers, two retention
  policies, two failure modes.

## Why Tigris-canonical (option 3)

- **Sleeping games hold no resources on any shard.** The next wake is a
  placement decision over current capacity, followed by one Tigris GET.
  Cross-shard migration is identical to wake.
- **Drain is a flush.** To drain a shard, flush all in-flight writes; the
  games are then unbound and can be placed elsewhere.
- **Per-shard volume usage is bounded by working set, not by lifetime.**
  Shard volumes hold Rivet engine internals only (pegboard scheduling,
  workflow rows). Not in the `c.state` durability path.
- **One backup story** — Tigris.
- **One consistency story** — Tigris is the source of truth; the
  in-process cache is a read-through and a write-buffer.

The cost: writes are not instantly durable. The substrate offers a
**configurable flush window** (default 1 second, tunable per preset down
to single-digit ms) and a `c.state.flush()` API for bundles that need a
specific write durable before continuing.

Guarantee #11 makes the durability story precise:

- **Planned transitions** (sleep, drain, cross-shard migration): the
  substrate flushes all pending writes before releasing the game. **Zero
  loss.**
- **Unplanned process or machine death**: at most the configured flush
  window of writes is lost. Recovery surfaces `cold-restart-from-storage`
  with the last durable state.

For `c.blob`, every `put` is durable on resolve (no buffering). This is
because `c.blob` puts are async by design, sized for blob-like payloads,
and the bundle expects them to be durable before the promise resolves.

## Tigris paths

| Tier | Tigris path |
|---|---|
| `c.state` | `state/<gameId>.cbor` (one object per game) |
| `c.blob` | `blob/<gameId>/<key>` (one object per key) |
| Bundle binaries | `bundles/<bundleName>/source.js` and `manifest.json` |
| History archives | `history/<shardId>/<runId or date>/<chunk>.jsonl.zst` |

All in one bucket (`pax-backend-blobs`). Lifecycle policies on Tigris
handle retention.

## What would change our mind

We'd revisit if any of these turn out to be true:

1. Tigris latency spikes make the 1s flush window observably bad for
   gameplay. (Spike evidence: not yet seen at v1 scale.)
2. Tigris egress cost becomes the dominant cost line. (Unlikely at 1k
   concurrent games.)
3. A use case emerges where the bundle requires synchronously-durable
   `c.state` writes inside a hot loop without calling `flush()`
   per-write. (Bundles can already work around this by tuning the flush
   window per preset.)

## See also

- [`contract/storage.md`](../contract/storage.md) — the full storage
  contract
- [`why-keyed-blob-not-snapshot.md`](why-keyed-blob-not-snapshot.md) —
  the related blob-tier shape decision
- [`vision/guarantees.md`](../vision/guarantees.md) #11/#12
- [`subsystems/parent-actor.md`](../subsystems/parent-actor.md) — the
  cache + flush implementation lives here
