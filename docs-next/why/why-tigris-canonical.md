# Why: Tigris is the canonical store

> Layer: **Why**

## Considered

Where the per-game persistent state lives — small, frequently mutated,
and wakeable on any shard, at a cost that stays sane from ~10k concurrent
sessions to a plausible ~100k:

1. **Per-shard embedded DB on a local volume** (RocksDB / SQLite). Hot
   writes are free and local; state lives with whatever shard last hosted
   the game.
2. **Per-shard embedded DB + log shipping to Tigris** (e.g. SQLite +
   Litestream). Local writes, continuous WAL/LTX shipping for cross-shard
   recovery.
3. **A central/managed database** for all games (Fly Postgres,
   Firestore, DynamoDB).
4. **Tigris object storage as the canonical store**, with each shard
   running a per-game read-through / write-back cache and committing at a
   checkpoint via a per-game root object (see
   [`subsystems/state-store.md`](../subsystems/state-store.md)).

We chose option 4.

## Why object storage at all

It is the only option that is **simultaneously**:

- **Horizontally scalable with no central write head.** Each shard
  checkpoints its own games directly to Tigris; write throughput scales
  with shard count. There is no single primary every write funnels
  through.
- **Wake-anywhere.** A game's durable identity is a root object keyed by
  `gameId`; any shard wakes it with one keyed GET. Nothing durable lives
  only on a shard.
- **Bounded by working set, not lifetime.** The dormant corpus (millions
  of never-recently-played games) lives only in Tigris, addressed by
  `gameId`, retrieved by point GET on wake. Storage is the only cost; cold
  lifecycle tiering handles the long tail.
- **One store, one backup story.** Tigris gives multi-region durability
  for free; there is one consistency story (Tigris is the source of truth;
  the shard cache is a read-through write-buffer).

Every database-shaped alternative sacrifices at least one of these.

## Why we said no to the alternatives

### Why not per-shard embedded DB (option 1)

- **Cross-shard migration is destructive and sleeping games are
  shard-pinned.** A game asleep for a week is tied to whatever shard last
  hosted it; if that volume dies, the state is gone. Per-shard volume
  usage grows with lifetime game count, not working set.
- **Drain means copying state.** Draining a shard requires moving every
  game's data somewhere, hundreds of round trips of state movement.
- **A coarse per-shard DB (one DB for all the shard's games) destroys
  per-game migration.** A single game's rows are buried in a
  shard-monolith; waking game G elsewhere means moving the whole shard's
  data. The wake-anywhere requirement effectively forces per-game durable
  granularity — exactly what the per-game root gives.

### Why not embedded DB + log shipping (option 2, kept as contingency)

A strong option: free local NVMe writes and a conditional-write lease for
single-writer fencing. But at per-game granularity it has the **same
per-game request floor** as object storage (one ship per dirty game per
interval), and it adds an embedded engine + replication layer and **two
consistency stories** (local DB + shipped log). Its real edge —
coarsening many games into one replicated DB — breaks per-game migration.
We keep it on the shelf for a future **high-frequency / real-time preset**
where free local writes beat per-checkpoint object PUTs.

### Why not a central / managed DB (option 3)

- **Single write head.** Fly Postgres funnels all shards through one
  primary; at high concurrency × flush rate × large rows it saturates
  even the top plan — the exact centralized-writer chokepoint diagnosed in
  the soak. It also caps storage well below the corpus size and costs
  ~14× Tigris per GB.
- **Size-metered stores are catastrophic for our payloads.** DynamoDB
  bills writes by item size (~1 KB WRUs); a 100 KB state write ≈ 100 WRUs
  ≈ ~25× worse than Tigris.
- **Flat-per-doc stores leave the ecosystem.** Firestore is genuinely
  cheap per write, but it is external (cross-cloud hop, a third-party
  trust boundary holding all state) and still per-operation priced. It
  does not beat "idle = free + per-checkpoint batching on a store we
  already use."

## The cost model behind the long default interval

Tigris charges on two axes only: **bytes stored** (~$0.02/GB-month) and
**operations** (Class A writes ~$5/M; Class B reads ~$0.50/M). There is no
per-byte-written charge and no egress charge. So object size does not
affect per-write cost; the only write-side driver is **request count per
checkpoint**.

In the default shape, requests per checkpoint per game = **1 root PUT if
the game mutated, else 0**. The key word is *mutated*, not *awake*: an
idle awake game is clean and writes nothing. Storage is a rounding error
(3M games × ~0.5 MB ≈ 1.5 TB ≈ ~$30/mo). Writes, at a 60 s interval with
~30% of awake games mutating per minute, land around ~$1-1.5k/mo at 10k
concurrent and ~$7-12k/mo at 100k — tunable down by lengthening the
interval (trading RPO). This is what keeps the simple object-storage
design viable into the 100k-concurrent range.

## What would change our mind

We'd revisit if any of these turn out true:

1. **Measured mutation rate contradicts "mutating games ≪ awake games."**
   The cost case rests on it; confirm it under soak before fixing the
   default interval. If most awake games mutate every interval, the
   default interval (not the store) changes first.
2. **Tigris latency spikes make even a short checkpoint interval
   observably bad** for a real-time preset — then the embedded-DB +
   log-shipping contingency (option 2) comes off the shelf for that preset.
3. **A use case needs synchronously-durable writes inside a hot loop**
   without `flush()` per write — addressed first by tuning the interval
   per preset, only then by revisiting the model.

## See also

- [`contract/storage.md`](../contract/storage.md) — the full storage
  contract
- [`why-one-state-object.md`](why-one-state-object.md) — why one object,
  keyed blob the escape hatch
- [`why-unified-durability.md`](why-unified-durability.md) — why
  checkpoint-based, one consistent snapshot
- [`subsystems/state-store.md`](../subsystems/state-store.md) — the root
  object, codecs, GC, and fencing
- [`subsystems/broker.md`](../subsystems/broker.md) — the cache + checkpoint
  scheduler lives here
- [`vision/guarantees.md`](../vision/guarantees.md) #11, #12
