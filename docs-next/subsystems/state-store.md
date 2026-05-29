# State store

> Layer: **Subsystem**

The state store is the substrate's per-game durable-state engine: the
read-through / write-back cache, the checkpoint that atomically commits a
game to Tigris, the version history behind time travel, and the garbage
collector that keeps it bounded. It runs **inside the Broker**
([`broker.md`](broker.md)) — the Broker is the sole egress to Tigris — but
it is enough of a thing on its own to document separately. The
author-facing surface it implements is [`contract/storage.md`](../contract/storage.md).

## Purpose

For each awake game:

- Serve `c.state` / `c.blob` reads from an in-memory cache; materialize a
  cold game from Tigris on wake.
- Absorb `c.state.write` / `c.blob.put` into the cache and a dirty set,
  off the hot path.
- At the checkpoint interval (or on `flush()` / planned sleep), commit the
  game atomically with a single root PUT.
- Keep a chain of immutable roots for time travel, and garbage-collect
  superseded versions precisely.
- Fence superseded shards via a conditional root PUT.

## Owns

- The per-game cache + dirty set.
- The checkpoint scheduler and the atomic-commit sequence.
- The root object format and the `checkpointSeq` counter.
- History codec selection (`whole` / `json-delta` / `cdc`) and adaptive
  re-basing.
- GC: supersede-on-commit plus the orphan reaper.
- The time-travel chain (`parent` links, `head` pointer) and view/restore.

## Doesn't own

- WebSocket transport, sessions, budgets, identity — that's the Broker.
- The `c.*` bridge to the isolate — that's the Broker ↔ Runner channel
  ([`reference/ipc-protocol.md`](../reference/ipc-protocol.md)).
- Bundle binaries (separate Tigris layout; see
  [`bundle-storage.md`](bundle-storage.md)).
- The author's value semantics — state is opaque bytes; the store only
  sniffs content to pick a codec.

## Inputs / outputs

| Direction | What |
|---|---|
| From Broker (on behalf of isolate) | `state.read/write/flush`, `blob.get/put/delete/list` |
| From control plane | drain / migrate / delete; time-travel list/view/restore |
| To Tigris | state objects, optional blob versions, the root PUT (conditional) |
| From Tigris | root GET on wake; state/blob materialization; version listing for GC/time-travel |

## The per-game root object

The root is a small **commit object**, e.g. `state/<gameId>.root.cbor`:

- `stateRef`: resolves to the current state bytes. For the default `whole`
  codec this is the **state bytes inline** (small); for a delta codec it
  points at a **base snapshot + the delta segments** since.
- `codec`: which codec produced this segment of history (`whole` |
  `json-delta` | `cdc`), so codecs can evolve per segment without
  migration.
- `checkpointSeq`: a monotonic counter, also the fencing/version token.
- `blobManifest` (optional): `{ key -> { version, size } }` for the keyed
  blob tier — empty by default, populated only if a game uses keyed blob.
- `parent` (when time travel is on): the prior root's id, making history a
  chain.
- `blobCompatTag`, `bundleCompatTag`: per [`bundle-compatibility.md`](../contract/bundle-compatibility.md).

The root stays small even for a large game, because state (under a delta
codec) and blobs are referenced, not inlined.

> **The root PUT is the only thing that makes a checkpoint real.** Any new
> state/blob objects are written first and are inert until a root
> references them. A crash mid-checkpoint leaves the previous root as the
> consistent truth.

## The cache and dirty set

- **Read-through:** `c.state.read()` / `c.blob.get(key)` serve from cache;
  a cold game is materialized from Tigris (root → state representation)
  and cached. Blob keys are lazy — fetched on first `get` via the
  manifest.
- **Write-back:** `c.state.write()` / `c.blob.put()` update the cache, add
  to the dirty set, and return immediately. Nothing touches Tigris on the
  hot path.
- **Clean** means the state and any blob keys are byte-identical to the
  last successful root. A clean game is skipped entirely at checkpoint
  time (the idle-is-free property).

## The checkpoint (atomic commit)

On the interval (or on `c.state.flush()` / planned sleep):

1. If nothing is dirty, **return without writing anything.**
2. Encode the changed state per the chosen codec — a whole-object body, or
   new delta segment(s) over the current base — writing any new state
   objects. Write any dirty blob keys as new immutable versions.
3. Write the **root object** with the new `stateRef`, `codec`,
   `checkpointSeq + 1`, and any `blobManifest`. **This PUT is the atomic
   commit**, and is conditional (see Fencing).
4. Mark clean. Schedule GC of anything the commit superseded.

If the machine dies before step 3 lands, the previous root still
references the previous state/blob versions: a clean, consistent rollback
to the prior checkpoint. No torn snapshot.

## Wake / hydration

Identical in shape across same-shard restart and cross-shard migration
(wake reason `cold-restart-from-storage`,
[`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md)):

1. One keyed `GET` of the game's root.
2. Materialize state from `stateRef` (inline bytes for `whole`; base +
   deltas applied for a delta codec, fetched in parallel and bounded by
   the snapshot interval) and hand it to `onWake({ state })`.
3. Blob keys stay lazy — fetched on first `c.blob.get(key)` via the
   manifest's version pointer.

The dormant corpus is never enumerated; a wake touches exactly one game's
objects.

## History codec (content-aware, per segment)

The default keeps **no history** (`whole` codec, root overwritten in
place). When time travel / retention is on, the codec is sniffed from the
bytes and tagged per segment, so it can change at any re-base without
recomputing old history (keep old decoders; switch forward):

| Data shape | Codec | Why |
|---|---|---|
| Small JSON state (common case) | **structural JSON delta** (RFC 6902 / jsondiffpatch) | compact, and a semantically meaningful change history an AI/storytelling product can use |
| Large opaque/binary, changed incrementally | **CDC** (content-defined chunking; FastCDC) | shift-resistant chunk boundaries dedup unchanged regions without author-chosen keys |
| Anything tiny, or a forced re-base | **whole-object** | simplest; below the delta break-even |

**Adaptive re-basing** bounds the pathological case without trusting
authors: if a delta exceeds, say, 50% of the base, write a full snapshot
instead. This handles "a tick changed every field," reorders, and binary
payloads automatically. Delta-encoding is justified by **history storage**
(deep retention of large objects), not by write count — one delta PUT
costs the same as one whole-object PUT on per-request pricing.

## Time travel: view vs restore

- **View the past** resolves `root@T` and serves it — read-only, free, no
  game disruption.
- **Restore the past** is **revert-forward**: write a new `root@N+1`
  referencing `root@T`'s immutable state/blob versions, then advance
  `head`. Bytes are not copied; the pointer is not moved backward
  destructively. A full-game rewind is one small PUT regardless of game
  size. See [`contract/storage.md`](../contract/storage.md) §Time travel.

Roots are immutable and chained by `parent`; `head` names the current
one. Content-addressing versions by hash gives free dedup of identical
content across versions when time travel is on.

## Garbage collection

- **Default shape (no history):** the root is overwritten in place, old
  `state` simply vanishes (object-store overwrites are atomic per object).
  Nothing accumulates; no GC needed.
- **Versioned modes (delta codec / keyed blob / time travel):** a changed
  object is written as a new immutable version **before** the root swaps
  to it. GC is precise because we always know what we orphaned:
  - **Supersede-on-commit:** at checkpoint we hold both old and new roots,
    so we know exactly which prior versions the change orphaned. After the
    root PUT commits, delete those specific versions (keep a small
    retention `N` for point-in-time). O(changed objects); no listing.
  - **Orphan reaper:** a checkpoint that wrote new versions then died
    before the root PUT leaves unreferenced versions. A periodic sweep
    deletes versions not referenced by the current root and older than a
    grace window (the grace avoids racing an in-flight checkpoint).
  - **Steady state is bounded:** current versions + `N` retained +
    transient in-flight. Time travel flips the policy from "supersede
    aggressively" to "retain within a horizon, then prune."

## Fencing: the root PUT as exclusivity point

The single root PUT per checkpoint is also where cross-shard exclusivity
is enforced: it is a **conditional write** keyed on `checkpointSeq` (Tigris
`If-Match` / compare on the expected prior version). A superseded shard
whose late checkpoint arrives after another shard advanced the game gets a
conflict and stands down instead of corrupting state. This is the
storage-layer backstop under the directory-claim exclusivity story in
[`placement-and-wake.md`](placement-and-wake.md) — fencing falls out of
the same commit the store already makes.

## Failure model

| Failure | Recovery |
|---|---|
| Crash before the root PUT | Previous root is the consistent truth; ≤ one interval lost; orphan reaper cleans new-but-unreferenced versions |
| Conditional root PUT conflict | Superseded shard stands down; the game is owned elsewhere |
| Tigris PUT failure on a state/blob object | Retry with backoff; surface `storageUnavailable` to the write if persistent (the root is not written, so no torn commit) |
| Materialize failure on wake (missing base/delta) | Surface as a storage error; the game does not wake on a partial snapshot |

## Trust position

**Shard-trusted**, as part of the Broker. It holds the Tigris credentials;
the Runner and isolate never touch Tigris. See
[`vision/trust-model.md`](../vision/trust-model.md).

## Observability surface

| Signal | Notes |
|---|---|
| Metrics: `pax_broker_checkpoint_*` (duration, bytes, dirty-game count, skipped-clean count), `pax_broker_state_materialize_seconds`, `pax_broker_gc_*` | Prometheus |
| Traces: `broker.checkpoint`, `broker.state.materialize`, `broker.gc.sweep` | OTLP |
| History events: `state.checkpoint`, `state.write`, `state.write.rejected`, `blob.*`, `state.restore` | per [`reference/event-schema.md`](../reference/event-schema.md) |

## End-state contract

- **A clean game writes zero objects at a checkpoint.**
- **The root PUT is atomic and conditional on `checkpointSeq`.**
- **A crash never yields a torn snapshot** — state and blob roll back
  together to the prior root.
- **Wake materializes from exactly one game's objects**, never a corpus
  scan.

## Cross-references

- [`contract/storage.md`](../contract/storage.md) — the author-facing
  contract this implements
- [`broker.md`](broker.md) — hosts the cache + checkpoint scheduler; sole
  Tigris egress
- [`why/why-unified-durability.md`](../why/why-unified-durability.md)
- [`why/why-tigris-canonical.md`](../why/why-tigris-canonical.md)
- [`why/why-one-state-object.md`](../why/why-one-state-object.md)
- [`reference/admin-api.md`](../reference/admin-api.md) — time-travel
  endpoints
- [`vision/guarantees.md`](../vision/guarantees.md) #11, #12
