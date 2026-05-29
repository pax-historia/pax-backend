# Why: one byte-level state object, not keyed tiers

> Layer: **Why**

## Considered

Three shapes for the author-facing storage surface:

1. **One byte-level state object the author writes.** "Write whatever you
   want; we version it." The substrate stores opaque bytes and commits the
   whole game atomically at a checkpoint. No keys, no tiers.
2. **Two co-equal tiers (small whole-object state + keyed blob namespace).**
   The author decides per value which tier it belongs in, by a rule like
   "small and hot → state; big or independently-addressed → blob."
3. **Keyed granularity everywhere.** Everything is a key in a namespace;
   the author always manages keys, even for the working state.

We chose option 1 as the **default**, and keep a keyed `c.blob` namespace
as an **optional, additive escape hatch** for the two cases the single
object handles poorly (huge state touched sparsely; large opaque binary).

## Why we said no to a keyed default (options 2 and 3)

Keyed granularity exists for exactly two things: **lazy partial reads**
(touch a little of a lot) and **large opaque binary**. The storytelling
workload has neither, so making authors manage keys is burden with little
payoff:

- **Authors almost always need their whole state.** A storytelling turn
  rebuilds the AI prompt from the world so far, so there is rarely state
  the game doesn't care about on a given tick. Unbounded history is
  handled by **summarization** — old rounds compress into a compact
  running state precisely so the hot state stays bounded — not by lazy
  access to a giant object.
- **Old raw detail is covered by version history, not a keyed tier.** "I
  need round 1 at round 500" is served by the author's running summary
  plus, for raw detail, **time travel to that version**. Old rounds *are*
  old versions; the versioning the substrate already builds is the
  cold-history tier, for free. (See
  [`contract/storage.md`](../contract/storage.md) §Time travel.)
- **Media is pointers, not bytes.** Worlds store a URL to an image, not
  the image — so no large opaque binary lands in state, and there is no
  near-term path to creators stuffing arbitrary unkeyed binary into games.

A keyed default also makes the contract worse on every other axis it
touches: it forces a "which tier?" decision on every value, it splits the
durability story across tiers (the source of the cross-tier-skew bug that
[`why-unified-durability.md`](why-unified-durability.md) kills), and it
complicates the budget surface. The single object is trivial to teach and
trivial to reason about.

## Why keep keyed blob at all (the escape hatch)

We do not delete the keyed tier — we demote it. It earns its keep the day
"huge state touched sparsely" or "large opaque binary" actually appears,
and it returns **additively**: the root object already carries an optional
blob manifest, so a game that uses keyed blob is a superset of one that
doesn't, not a different code path. Authors who never reach for it never
see it.

## What would change our mind

We'd promote keyed blob from escape hatch back toward the default if:

1. **The average bundle ends up reading or writing a large fraction of a
   big keyed namespace on every wake**, making lazy access the common
   case rather than the exception — i.e. the workload turns out to be
   "huge state touched broadly."
2. **Creators start storing large opaque binary in games** (not URL
   pointers), so large-binary handling becomes a first-class need rather
   than a deferred one.

Neither is true for Pax-historia today. If a future workload proves us
wrong, the escape hatch is already specified and shipped; only the default
guidance changes.

## See also

- [`contract/storage.md`](../contract/storage.md) — the full storage
  contract
- [`why-unified-durability.md`](why-unified-durability.md) — why one
  consistent snapshot, checkpoint-durable
- [`why-tigris-canonical.md`](why-tigris-canonical.md) — why the bytes
  live in Tigris
- [`subsystems/state-store.md`](../subsystems/state-store.md) — codecs and
  version history mechanics
