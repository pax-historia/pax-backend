# Why: `c.blob` is keyed; `onWake` does not inline the namespace

> Layer: **Why**

## Considered

Three earlier design sketches for the substrate's persistent storage:

1. **One big serialized blob per game.** The bundle's entire persistent
   state is a single CBOR/JSON blob the substrate reads, hands to `onWake`,
   and writes back on `onSleep`. Pax-historia's pre-substrate `s3Put/s3Get`
   pattern is shaped like this.
2. **Keyed namespace, eager-snapshot on wake.** The bundle gets a keyed
   namespace, but `onWake` receives the entire namespace inlined as a
   `{ [key]: bytes }` object. The bundle can write back via `c.blob.put`.
3. **Keyed namespace, lazy reads on demand.** The bundle gets keyed I/O
   (`c.blob.put/get/delete/list`). `onWake` receives only metadata
   (`bundleName`, compat tags, lifecycle reason). The bundle pulls blob
   contents lazily via `c.blob.get(key)` when it needs them.

We chose option 3.

## Why we said no to options 1 and 2

### Why not option 1 (single big blob)

- **Write amplification.** Every change requires rewriting the whole blob.
  For a bundle with 50 chapter files plus moderation snapshots plus
  workflow blobs, a 1KB chat message rewrites tens of MB.
- **Per-key concurrency.** Two writes to different "fields" of the blob
  serialize through the read-modify-write cycle.
- **No partial fetch.** Cold-load on every wake transfers the whole blob,
  even if the bundle is about to use 1KB of it.
- **Incremental retention.** Want to keep N old moderation snapshots? In
  the single-blob model, all of them are inside the same object. Keyed
  storage with `c.blob.list({ prefix: 'mod-snapshots/' })` is much cleaner.

### Why not option 2 (eager-snapshot on wake)

- **Cold-wake cost.** Every wake — even one that only handles a single
  player reconnect — pulls the whole namespace into memory. With ≤100 MB
  per game allowed, that's up to 100 MB transferred per wake.
- **Bundle author footgun.** A bundle that writes large blobs (e.g. workflow
  source code, image caches) pays the full transfer cost every wake whether
  it reads them or not.
- **Memory pressure** is harder to reason about. The substrate's per-child
  memory budget (`memory-bytes`) tracks live RSS; eagerly hydrating a
  100 MB namespace burns 100 MB of that budget for no good reason.
- **Conflicts with `cold-restart-from-storage`** wake semantics, which
  should be observably cheap and deterministic. Eager hydration makes
  cold-restart timing a function of namespace size, not a constant.

## Why lazy keyed reads (option 3)

The substrate's job is to provide cheap, predictable I/O primitives. Lazy
keyed reads let the bundle:

- Hydrate exactly what it needs on wake.
- Stream chapter blobs on demand instead of preloading them.
- Treat the namespace as a database with `list(prefix)` queries.
- Pay write cost per-key, not per-namespace.

`onWake` therefore receives only **metadata + state**:

```ts
{
  reason: WakeReason,
  runId: string,
  bundleName: string,
  bundleCompatTag: string,
  blobCompatTag?: string,    // undefined on cold-start
  state: unknown | null      // the c.state contents (≤128 KB)
}
```

The bundle pulls blob keys with `c.blob.get(key)` (returns `bytes` or
`null`), enumerates with `c.blob.list(prefix?)`, writes with
`c.blob.put(key, bytes)`, deletes with `c.blob.delete(key)`. Substrate
caps: ≤ 1024 keys per game, ≤ 100 MB total per game.

`c.state` (the small, eagerly-hydrated tier) is separate. It carries the
"working state" that needs to be at hand on every handler tick. ≤ 128 KB,
whole-object read/write, eagerly available on `onWake`. The line between
the two:

> **`c.state`** if it's small and read often.
> **`c.blob`** if it's big or you need synchronous-durable-on-write.

A storytelling bundle keeps the current paragraph in `c.state` (fast,
capped) and checkpoints completed chapters into `c.blob` under
`chapter-12.json` keys (explicit, durable).

## What would change our mind

We'd switch to eager snapshot if **the average bundle ends up calling
`c.blob.get` against >50% of its keys on every wake**, making the lazy
path strictly more expensive than a single bulk transfer. We don't expect
this for Pax-historia's storytelling and game shapes. If a future bundle
shape proves us wrong, the substrate can add an opt-in "preload" hint on
the manifest without changing the lazy API.

## See also

- [`contract/storage.md`](../contract/storage.md) — the full storage tier
  contract
- [`why-tigris-canonical.md`](why-tigris-canonical.md) — why both tiers
  live in Tigris
- [`vision/guarantees.md`](../vision/guarantees.md) #11/#12 — durability
  guarantees
