# Storage

> Layer: **Contract**

Two tiers, one canonical store. The substrate's job is to keep the
bundle-facing surface small and predictable while pushing the "where do
the bytes live" complexity behind the scenes.

## The three places bytes can live

| Tier | Volatility | Cap | API shape |
|---|---|---|---|
| **JavaScript variables in the child** | Lost on any process restart | None (subject to `memory-bytes` budget) | Whatever JS gives you |
| **`c.state`** | Tigris-canonical; flush-window durability | 128 KB whole-object | `read()` / `write()` / `flush()` |
| **`c.blob`** | Tigris-canonical; durable on resolve | 1024 keys, 100 MB total per game | `put(key, bytes)` / `get(key)` / `delete(key)` / `list(prefix?)` |

The three-color rule for bundle authors:

> **JavaScript variables** if it's reconstructable.
>
> **`c.state`** if it's small and read often.
>
> **`c.blob`** if it's big, or you need synchronous-durable-on-write, or
> you want to address keys independently.

Pax-historia's `historia-default` bundle keeps the current paragraph in
`c.state` (fast, eagerly hydrated) and checkpoints completed chapters
into `c.blob` under keys like `chapter-12.json` (explicit, durable per
key, listable).

## `c.state` — managed per-game state tier

One CBOR-serializable value per game, ≤ 128 KB. Whole-object read and
write.

### API

```ts
c.state.read(): Promise<unknown>
c.state.write(value: unknown): Promise<StorageWriteResponse>
c.state.flush(): Promise<StorageWriteResponse>
```

`StorageWriteResponse` is `{ ok: true }` or `{ ok: false, error:
'sizeExceeded' | 'storageUnavailable', detail?: unknown }`.

### Semantics

- **Read** returns the in-process cached value (which equals the canonical
  Tigris value modulo any in-flight flush).
- **Write** updates the cache and queues a durable flush. Returns when the
  cache update lands, **before** the Tigris flush completes.
- **Flush** forces an immediate synchronous Tigris write. Returns when
  Tigris acks the write.

### Durability

The substrate's canonical store is Tigris (one object per game at
`state/<gameId>.cbor`). The in-process cache makes writes feel
synchronous; a configurable **flush window** (default 1 second, tunable
per preset down to single-digit ms) bounds how long a write may sit in
the cache before being durable.

Two cases:

| Case | What's lost |
|---|---|
| **Planned transition** (`onSleep` fires, drain, cross-shard migration) | Zero. The substrate flushes pending writes before releasing the game (guarantee #11) |
| **Unplanned process or machine death** | At most the configured flush window of writes. The next wake surfaces `cold-restart-from-storage` with the last durable state |

Bundles that need a specific write durable before continuing call `await
c.state.flush()` synchronously.

### Available on wake

`c.state.read()` is eagerly hydrated. `onWake` receives `state` (== the
cached value) directly in its payload. The bundle does **not** need to
call `c.state.read()` to get initial state on wake; it can just use
`payload.state`.

### Size enforcement

A `c.state.write` whose CBOR-serialized size exceeds 128 KB returns
`{ ok: false, error: 'sizeExceeded' }`. The bundle is responsible for
deciding what to spill to `c.blob`.

## `c.blob` — keyed per-game namespace

One Tigris namespace per game at prefix `blob/<gameId>/`. Each key maps
to one Tigris object. Caps: ≤ 1024 keys, ≤ 100 MB total per game.

### API

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

- **`put`**: durable on resolve. The Tigris write must succeed before the
  promise resolves. No buffering.
- **`get`**: reads from Tigris. Returns `null` if the key doesn't exist.
- **`delete`**: idempotent. Removing a key that doesn't exist is a no-op.
- **`list(prefix?)`**: enumerates keys in the per-game namespace, optionally
  filtered by prefix. Returns key names and sizes (not contents).

### Caps and enforcement

- **`blob-keys` budget**: distinct key count ≤ 1024 per game. A `put` that
  would create the 1025th distinct key returns
  `{ ok: false, error: 'keyCountExceeded' }`.
- **`blob-bytes` budget**: sum of all key sizes ≤ 100 MB per game. A `put`
  that would push the total over returns
  `{ ok: false, error: 'sizeExceeded' }`.

Per-key size limit is implied by the per-game `blob-bytes` cap — there is
no separate per-key cap.

### Lazy reads, no whole-namespace snapshot

`onWake` does **not** inline the blob namespace. The bundle pulls keys
lazily via `c.blob.get(key)`. See
[`why/why-keyed-blob-not-snapshot.md`](../why/why-keyed-blob-not-snapshot.md).

### Namespace-level compat tag

Each game has exactly **one** `blobCompatTag`, stamped on every
successful sleep from the bundle's `compatTagProduced`. The tag applies
to the namespace as a whole, not per-key. Per-key versioning inside the
namespace is the bundle's problem (e.g. naming keys
`chapter-v2-12.json`).

### Substrate-side operations on the namespace

- **`GET /admin/games/:id/snapshot`** can include the full blob contents
  (default) or exclude them (`?includeBlob=false`).
- **`DELETE /admin/games/:id`** clears all keys in the namespace.
- Cross-shard migration moves the namespace as a unit by virtue of
  Tigris being canonical (no copying; the new shard reads from the same
  prefix).

## What survives what

| Event | `c.state` | `c.blob` |
|---|---|---|
| Player disconnect (within sleep-grace) | Intact, in-process | Intact, Tigris |
| Sleep | Flushed before release; intact in Tigris | Intact, Tigris |
| Cross-shard migration | Flushed before release; intact in Tigris | Intact, Tigris |
| Child crash | ≤ flush window lost | Intact (puts already resolved are durable) |
| Shard machine loss | ≤ flush window lost | Intact (Tigris multi-region) |
| Bundle flip | Intact through flip; the new bundle reads via `onWake` payload | Intact; namespace `blobCompatTag` unchanged until the new bundle sleeps |
| Game delete | Cleared | Cleared |

## Six nouns of a game (by design)

The substrate models a game as exactly six things:

1. **Identity** (`gameId`)
2. **Bundle pointer** (`currentBundleName`)
3. **State** (one `c.state` object)
4. **Blob namespace** (one `c.blob` namespace)
5. **Roster** (`allowedPlayers`)
6. **Ephemeral derived state** (sessions, recent history, recent `api.invoke` records)

Anything that wants to be a seventh top-level noun is an alarm bell. The
blob namespace's internal keying is structure within the namespace, not
a new noun — the same way a database table has rows.

## Engineering latitude

The contract above states **what bundles and the vercel backend can
rely on**: whole-object 128 KB state with a configurable flush window;
keyed blob with caps; zero loss on planned transitions; durable-on-resolve
puts; namespace-as-a-unit semantics.

The mechanics that satisfy those guarantees are implementation choices,
not contract:

- Whether the flush path uses conditional writes, generation numbers,
  ETags, or local sequence counters to suppress lost-update races on
  concurrent flushes.
- Whether failed Tigris PUTs are retried with backoff, deferred to a
  background reaper, or surfaced immediately as `storageUnavailable`.
- Whether stale local caches are invalidated by polling, pub-sub
  invalidation, or read-through revalidation on cold wake.
- Whether the bundle pointer flip and the `c.state` flush coordinate
  via a single Redis write, a control-plane reconciliation loop, or a
  parent-actor handshake.

The substrate is free to evolve these mechanics as long as the
scenario-runner's guarantee oracles (#11, #12, #14) continue to pass.

What the substrate does **not** claim:

- **No cross-store atomic commit.** Tigris and Redis are two stores
  with independent failure modes; the substrate does not promise that a
  multi-key blob write and a Redis index update either both succeed or
  both fail. Instead, write-ordered operations are recoverable: bytes
  land in Tigris first, the smallest possible Redis commit is the
  finalize step, and orphan Tigris objects from interrupted writes are
  garbage-collected. See [`subsystems/bundle-storage.md`](../subsystems/bundle-storage.md)
  for the bundle-upload-specific instance.
- **No transactional `blob.put` across multiple keys.** Each `put` is
  durable on its own resolve. A bundle that needs two keys to "land or
  not land together" needs to model that with a finalize key, a
  generation marker, or its own naming convention. The substrate does
  not expose multi-key transactions.

## Cross-references

- [`why/why-tigris-canonical.md`](../why/why-tigris-canonical.md) — why
  both tiers live in Tigris
- [`why/why-keyed-blob-not-snapshot.md`](../why/why-keyed-blob-not-snapshot.md)
  — why blob is keyed and lazy
- [`bundle-compatibility.md`](bundle-compatibility.md) — `blobCompatTag`
  semantics
- [`compute-budgets.md`](compute-budgets.md) — `state-bytes`, `blob-bytes`,
  `blob-keys` budgets
- [`vision/guarantees.md`](../vision/guarantees.md) #11, #12
- [`subsystems/parent-actor.md`](../subsystems/parent-actor.md) — the
  cache + flush implementation
