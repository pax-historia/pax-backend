# Storage

> Layer: **Contract**

One canonical store, one object the author writes. A game is **one
consistent snapshot, committed atomically at checkpoints**, behind **one
opaque state object**. The substrate's job is to make the author contract
trivial — "write whatever you want; we version it" — while keeping the
"where do the bytes live, when do they become durable, how do we roll
back" complexity behind the scenes.

## The author contract: one byte-level state object

The contract collapses to the simplest possible thing: **the author
writes one state object and the substrate versions it.** No keys to
manage, no granularity decisions, no rules about which tier a value
belongs in.

```ts
c.state.read(): Promise<unknown>
c.state.write(value: unknown): Promise<StorageWriteResponse>
c.state.flush(): Promise<StorageWriteResponse>
```

`StorageWriteResponse` is `{ ok: true }` or `{ ok: false, error:
'sizeExceeded' | 'storageUnavailable', detail?: unknown }`.

A thin typed helper (`c.state.read()` / `c.state.write(obj)` /
`c.state.flush()`) sits over a **byte-level core**: `write` serializes
the value (JSON by convention, CBOR-compatible), and the substrate
stores **opaque bytes**. The substrate stays content-agnostic — it never
parses the author's value except to pick a history codec (see
[`subsystems/state-store.md`](../subsystems/state-store.md)). This
decoupling is what lets the substrate keep a flexible binary substrate
**and** efficient JSON history at once, with no author-facing fork.

### Semantics

- **Read** returns the in-memory cached value, which equals the canonical
  Tigris value modulo any in-flight checkpoint. On a cold wake the value
  is materialized from Tigris first (see *Wake / hydration*).
- **Write** updates the cache, marks the game dirty, and returns
  immediately. Nothing touches Tigris on the hot path.
- **Flush** forces an immediate checkpoint and returns when Tigris acks
  the atomic commit (the root PUT).

### Available on wake

`c.state` is eagerly hydrated. `onWake` receives `state` (== the cached
value) directly in its payload; the bundle does **not** need to call
`c.state.read()` to get initial state on wake.

### Size enforcement

A `c.state.write` whose serialized size exceeds the `state-bytes` budget
(see [`compute-budgets.md`](compute-budgets.md)) returns
`{ ok: false, error: 'sizeExceeded' }`. The cap keeps the hot,
eagerly-hydrated core bounded; a game with genuinely large or
sparsely-touched state reaches for the keyed blob escape hatch below.

## Durability is unified and checkpoint-based

The substrate runs a per-game read-through / write-back cache in the
Broker ([`subsystems/broker.md`](../subsystems/broker.md)). At a tunable
**checkpoint interval** the Broker writes the changed state and then a
small **root object** whose single PUT is the **atomic commit** for the
whole game.

| Event | What's lost |
|---|---|
| **Planned transition** (`onSleep`, drain, cross-shard migration) | Zero. The substrate checkpoints synchronously before releasing the game (guarantee #11) |
| **Unplanned process or machine death** | At most one checkpoint interval of writes. The next wake surfaces `cold-restart-from-storage` with the last committed snapshot |

Two properties fall out of this model and matter to authors:

- **One consistent snapshot, never a torn one.** Everything a game wrote
  — `c.state` and any keyed blob — becomes durable together at the
  checkpoint. After a crash you never see "the item landed in blob but
  the inventory count in state rolled back." The whole game rolls back to
  one consistent checkpoint. See
  [`why/why-unified-durability.md`](../why/why-unified-durability.md).
- **Idle is free.** A clean (unmutated) game writes **nothing** at a
  checkpoint. An open background tab, a player reading or thinking, a
  bundle with no time-based mutation — all cost zero. Storage cost scales
  with *write activity*, not with the number of awake games.

Bundles that need a specific write durable before continuing call `await
c.state.flush()`, which forces an immediate checkpoint independent of the
interval.

> **The checkpoint interval is the single cost/RPO dial.** It *is* the
> recovery-point objective: unplanned death loses at most one interval.
> The default leans long (target ~30-60 s) for the storytelling workload;
> it is tunable per preset down to single-digit ms for a real-time
> preset. See [`why/why-unified-durability.md`](../why/why-unified-durability.md).

## Time travel

Because every checkpoint is a complete consistent snapshot committed by
one root PUT, keeping the old roots turns the same machinery into a
time-travel store. This is a first-class capability, not an afterthought:
roots are **immutable and chained** (`root@1, root@2, …`, each naming its
`parent`), with a tiny `head` pointer naming the current one. The model
is exactly Git's (commits + HEAD + content-addressed objects) and
Iceberg/Delta's (snapshots + a metadata pointer).

Two operations, different answers:

- **View the past** is free and read-only: resolve `root@T` and serve it.
  No write, no game disruption.
- **Restore the past** is **revert-forward, not reset-backward**: the
  substrate writes a *new* `root@N+1` whose contents reference `root@T`'s
  (immutable, shared) state/blob versions, then advances `head`. Bytes are
  **not** copied (the immutable versions are referenced) and the pointer
  is **not** moved backward destructively (`git revert`, not `git reset`).
  History stays auditable ("at N+1 we rewound to T") and the rewind is
  itself reversible. A full-game rewind is therefore **one small PUT**
  regardless of game size.

Time travel is exposed operationally (list snapshots, view at T, restore)
through the admin surface — see [`reference/admin-api.md`](../reference/admin-api.md)
and [`subsystems/control-plane-admin-api.md`](../subsystems/control-plane-admin-api.md).
The retention horizon is the one extra dial it introduces. The internal
snapshot/delta encoding that keeps deep retention affordable lives in
[`subsystems/state-store.md`](../subsystems/state-store.md).

## `c.blob` — keyed escape hatch

Most games never need it: the default is one byte-level state object. But
for the two cases the single object handles poorly — **huge state touched
sparsely** (you want lazy partial reads) and **large opaque binary** —
the substrate ships a keyed per-game namespace.

```ts
c.blob.put(key: string, bytes: Uint8Array): Promise<StorageWriteResponse>
c.blob.get(key: string): Promise<Uint8Array | null>
c.blob.delete(key: string): Promise<{ ok: true }>
c.blob.list(prefix?: string): Promise<readonly { key: string, size: number }[]>
```

`StorageWriteResponse` for `c.blob.put` is `{ ok: true }` or `{ ok: false,
error: 'sizeExceeded' | 'keyCountExceeded' | 'storageUnavailable',
detail?: unknown }`.

### Semantics

- **`put`**: lands in the cache and marks the key dirty; returns
  immediately. The key becomes durable at the next checkpoint / `flush()`
  / planned sleep — **the same unified-durability rule as `c.state`**.
  (This is the one guarantee shift from earlier designs; see
  [`why/why-unified-durability.md`](../why/why-unified-durability.md).
  A bundle that needs a specific key durable right now calls
  `c.state.flush()`, which commits the whole game.)
- **`get`**: reads from cache, or lazily from Tigris on first touch via
  the root's blob manifest. Returns `null` if the key doesn't exist.
- **`delete`**: idempotent. Removing a missing key is a no-op.
- **`list(prefix?)`**: enumerates keys (names and sizes, not contents),
  optionally filtered by prefix.

### Lazy reads, no whole-namespace snapshot

`onWake` does **not** inline the blob namespace. The bundle pulls keys
lazily via `c.blob.get(key)`. This is the whole point of the tier — a
game with a large namespace materializes only its working set on wake.
See [`why/why-one-state-object.md`](../why/why-one-state-object.md) for
why the default is the single object and keyed blob is the escape hatch.

### Caps and enforcement

- **`blob-keys` budget**: distinct key count ≤ cap per game. A `put`
  creating one key past the cap returns `{ ok: false, error:
  'keyCountExceeded' }`.
- **`blob-bytes` budget**: sum of key sizes ≤ cap per game. A `put`
  pushing past the cap returns `{ ok: false, error: 'sizeExceeded' }`.

Per-key size is implied by the per-game `blob-bytes` cap — no separate
per-key cap. See [`compute-budgets.md`](compute-budgets.md).

### Namespace-level compat tag

A game carries one `blobCompatTag`, stamped on every successful sleep
from the bundle's `compatTagProduced`. It applies to the state object and
the namespace as a whole, not per-key. See
[`bundle-compatibility.md`](bundle-compatibility.md).

## What survives what

| Event | `c.state` | `c.blob` (if used) |
|---|---|---|
| Player disconnect (within sleep-grace) | Intact, in cache | Intact, in cache |
| Sleep | Checkpointed before release; intact in Tigris | Checkpointed before release; intact in Tigris |
| Cross-shard migration | Checkpointed before release; intact in Tigris | Checkpointed before release; intact in Tigris |
| Runner crash | ≤ one checkpoint interval lost | ≤ one checkpoint interval lost (rolls back **with** state, no skew) |
| Shard machine loss | ≤ one checkpoint interval lost | ≤ one checkpoint interval lost (rolls back with state) |
| Bundle flip | Intact through flip; new bundle reads via `onWake` payload | Intact; namespace `blobCompatTag` unchanged until the new bundle sleeps |
| Game delete | Cleared | Cleared |

The whole-game rollback is the headline: a crash never leaves `c.state`
and `c.blob` at different points in time.

## Six nouns of a game (by design)

The substrate models a game as exactly six things:

1. **Identity** (`gameId`)
2. **Bundle pointer** (`currentBundleName`)
3. **State** (one `c.state` object, versioned)
4. **Blob namespace** (one optional `c.blob` namespace)
5. **Roster** (`allowedPlayers`)
6. **Ephemeral derived state** (sessions, recent history, recent `api.invoke` records)

Anything that wants to be a seventh top-level noun is an alarm bell. The
blob namespace's internal keying is structure within the namespace, not a
new noun — the same way a database table has rows. The version history
behind the state object is structure within noun #3, not a new noun.

## Engineering latitude

The contract above states **what bundles and the vercel backend can rely
on**: write one opaque state object; checkpoint-interval durability with
zero loss on planned transitions; one consistent snapshot (no cross-tier
skew); time travel by immutable root; keyed blob with caps when reached
for.

The mechanics that satisfy those guarantees are implementation choices,
not contract, and live in [`subsystems/state-store.md`](../subsystems/state-store.md):

- Which history codec encodes a segment (`whole` / `json-delta` / `cdc`),
  the sniff heuristic, and the adaptive re-base threshold.
- Whether the root inlines the state bytes (`whole`) or references a base
  snapshot plus deltas.
- How superseded versions are garbage-collected (supersede-on-commit plus
  an orphan reaper).
- How the root PUT is made conditional (`If-Match` on `checkpointSeq`) to
  fence a superseded shard's late checkpoint.
- Whether time-travel versions are content-addressed by hash for free
  dedup.

The substrate is free to evolve these as long as the scenario-runner's
guarantee oracles (#11, #12, #14) keep passing.

What the substrate does **not** claim:

- **No multi-key transactional API exposed to bundles.** Atomicity is the
  substrate's internal root-swap, not a bundle-facing transaction. A
  bundle does not get `beginTransaction`; it gets "everything you wrote is
  committed together at the checkpoint."

## Cross-references

- [`why/why-one-state-object.md`](../why/why-one-state-object.md) — why
  the default is one byte object, keyed blob the escape hatch
- [`why/why-unified-durability.md`](../why/why-unified-durability.md) —
  why durability is checkpoint-based and one consistent snapshot
- [`why/why-tigris-canonical.md`](../why/why-tigris-canonical.md) — why
  state lives in Tigris
- [`subsystems/state-store.md`](../subsystems/state-store.md) — the root
  object, codecs, GC, fencing, and time-travel mechanics
- [`subsystems/broker.md`](../subsystems/broker.md) — the cache + checkpoint
  scheduler
- [`bundle-compatibility.md`](bundle-compatibility.md) — `blobCompatTag`
- [`compute-budgets.md`](compute-budgets.md) — `state-bytes`, `blob-bytes`,
  `blob-keys`
- [`vision/guarantees.md`](../vision/guarantees.md) #11, #12
