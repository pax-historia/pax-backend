# Why: one consistent snapshot, committed at a checkpoint

> Layer: **Why**

## Considered

Three durability models for per-game state:

1. **Per-write durability, per tier.** `c.state` writes flush on a short
   window; `c.blob` puts are durable the instant the promise resolves.
   Each tier becomes durable on its own schedule.
2. **Synchronous durability on every write.** Every `c.state.write` and
   `c.blob.put` blocks until Tigris acks. No cache, no window.
3. **Unified checkpoint durability.** Every write lands in an in-memory
   cache and returns immediately; at a tunable checkpoint interval (or on
   `flush()` / planned sleep) the whole game is committed atomically by a
   single root PUT. State and blob become durable **together**.

We chose option 3.

## Why we said no to options 1 and 2

### Why not option 1 (per-write / per-tier durability)

- **Cross-tier skew on crash.** If `c.blob` is durable on resolve but
  `c.state` flushes on a window, an unplanned death between a blob put and
  the next state flush leaves an inconsistent game: "the item is in blob
  but the inventory count in state rolled back." This is the exact
  torn-snapshot bug the substrate exists to avoid, just moved to crash
  time. Two tiers with two durability clocks can never promise one
  consistent point-in-time.
- **No clean rollback target.** With each object becoming durable at a
  different instant there is no single "last good snapshot" to wake from;
  recovery has to reconcile tiers that disagree about *when* they last
  committed.
- **Object storage has no multi-object transaction.** Writing N changed
  objects as N independent durable writes is N chances to crash halfway.
  The only way to get real atomicity on object storage is to write the
  changed objects first and then **swap a single pointer** — which is a
  checkpoint, not per-write durability.

### Why not option 2 (synchronous per-write durability)

- **It puts durable I/O on the hot path.** Every player message that
  mutates state would block on a Tigris round trip. The runtime's whole
  premise is that nothing fsyncs between a player message and the response
  ([`subsystems/broker.md`](../subsystems/broker.md)).
- **It makes idle games expensive and busy games slow.** It also defeats
  the "idle is free" property: a checkpoint of a clean game writes
  nothing, but per-write durability has already paid for every keystroke.
- **It costs the most on a per-request-priced store.** One PUT per write
  instead of one PUT per checkpoint per dirty game is orders of magnitude
  more Class-A operations. See [`why-tigris-canonical.md`](why-tigris-canonical.md).

## Why unified checkpoint durability (option 3)

- **One consistent snapshot, never torn.** Everything the game wrote
  becomes durable at the same instant — the root PUT. After a crash the
  game rolls back, in full, to the previous checkpoint. No tier disagrees
  with another about what time it is.
- **The interval is the one honest dial.** It *is* the recovery-point
  objective: unplanned death loses at most one interval of writes.
  Lengthen it to cut cost, shorten it to cut RPO, per preset. Planned
  transitions checkpoint synchronously before release, so they lose
  nothing (guarantee #11).
- **Idle is free.** A clean game writes nothing at a checkpoint. Cost
  scales with mutation, not with the number of awake games — the property
  that keeps the simple object-storage design viable into the
  100k-concurrent range.
- **The root swap is the atomicity and the fencing point.** The same
  single PUT that makes the checkpoint real is also where cross-shard
  exclusivity is enforced cheaply, via a conditional write on
  `checkpointSeq` (see [`subsystems/state-store.md`](../subsystems/state-store.md)).

## The price we pay (stated honestly)

`c.blob` durability moves from "durable the instant `put` resolves" to
"durable at the next checkpoint." A bundle that relied on
"blob put resolved ⇒ durable right now" must instead call `c.state.flush()`
(which commits the whole game) at the boundary that needs zero loss. This
is the deliberate cost of one consistent snapshot, and it is small: the
storytelling proof bundle checkpoints chapters and simply flushes at
chapter boundaries. The win — no cross-tier skew, ever — is worth it.

## What would change our mind

- **A preset needs true zero-RPO without an explicit flush per write.**
  Then the interval shrinks toward zero for that preset; if even that is
  insufficient we'd revisit per-write durability for that preset only,
  accepting its cost.
- **Measured flush/mutation rates contradict "mutating games ≪ awake
  games."** The cost case for a long default interval rests on that
  assumption; if a soak shows most awake games mutate every interval, the
  default interval (not the model) changes. This is the trigger named in
  [`why-tigris-canonical.md`](why-tigris-canonical.md).

## See also

- [`contract/storage.md`](../contract/storage.md) — the durability
  contract authors rely on
- [`why-one-state-object.md`](why-one-state-object.md) — why one object is
  the default
- [`why-tigris-canonical.md`](why-tigris-canonical.md) — the cost model
  behind a long default interval
- [`subsystems/state-store.md`](../subsystems/state-store.md) — the root
  PUT, conditional-write fencing, and GC
- [`vision/guarantees.md`](../vision/guarantees.md) #11, #12
