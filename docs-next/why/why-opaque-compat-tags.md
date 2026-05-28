# Why: opaque compat tags (set membership only)

> Layer: **Why**

## Considered

A substrate-aware schema-versioning model where the platform understands
something about bundle compatibility beyond string equality:

- **Monotonic integer versions.** Bundle declares `schemaVersion: 7`;
  substrate enforces `newSchema >= oldSchema` on flip.
- **Semantic versions.** `compatRange: ">=1.2.0 <2.0.0"`, with the
  substrate evaluating semver intersections.
- **Predecessor / successor graphs.** A `migration-registry` maps known
  schemas; substrate chains intermediate bundles through the graph.
- **A "schema family" axis.** Bundles declare a `family: 'chat'`; the
  substrate refuses cross-family flips.
- **Avro/Protobuf-style content hashing.** Substrate computes
  schema-from-data fingerprints.

Each of these would let the substrate help operators by computing migration
paths, refusing nonsense flips with rich error messages, and surfacing
schema-evolution alerts.

## Why we said no

The substrate has zero domain knowledge about what bundles do, what data
they store, or what their migration semantics are. Any opinion the
substrate forms is wrong for some operator. Five concrete failure modes:

1. **Linear monotonic integers** fail when operators want branching
   schemas (a `chat:v5-stable` and `chat:v5-experimental` that recombine
   at `chat:v6`).
2. **Semver** fails when schemas aren't semantically versioned (content
   hashes, family names like `arena:v1`).
3. **Predecessor graphs** require the substrate to know about migrations,
   which requires the substrate to know about schemas, which is the very
   thing it tries to avoid.
4. **Family axes** fail when a bundle deliberately forks families (an
   "arena" bundle reads `chat:v9` to migrate users into a new family).
5. **Content hashing** ties the substrate to the operator's choice of
   schema framework.

The clean separation: **the substrate enforces set membership and nothing
else**. Each bundle declares `compatTagProduced: string` (what it writes)
and `compatTagsAccepted: string[]` (what it can read). The substrate
refuses any flip or cold wake where `game.blobCompatTag ∉
bundle.compatTagsAccepted`. **The substrate has no opinion about what the
tag strings mean.**

Concretely:

| Operator naming pattern | What the substrate sees |
|---|---|
| `"v1"`, `"v2"`, `"v3"` (linear integer) | Three opaque strings |
| `"chat:v3"`, `"strategy:v7"` (family-scoped) | Two opaque strings |
| `"chat:v5-stable"`, `"chat:v5-experimental"` (branching) | Two opaque strings |
| `"sha256:abc123..."` (content hashing) | One opaque string |
| `"arena:v1"` (family fork) | One opaque string |

Every one of those patterns works with set membership. The substrate's
five-field contract (`compatTagProduced`, `compatTagsAccepted`, plus the
three identity/version fields) is the same regardless. **Operators
encode whatever policy they want in the strings** without library
changes.

## The flip side: what the substrate can't do

Because the substrate has no schema vocabulary, it cannot:

- Compute migration paths between two tags.
- Suggest intermediate bundles to bridge a gap.
- Detect "you're about to flip to an incompatible bundle" before the
  flip is attempted.

It compensates by exposing the current tag population so vercel backend
tooling can compute migration paths client-side:

- `GET /admin/games/compat-tags` — histogram by current `blobCompatTag`.
- `GET /admin/games/by-compat-tag/:tag` — paginated list of games at a
  tag.
- `GET /admin/games/:id/bundle-compat?bundleName=...` — dry-run of the
  flip gate.

With those three, a deploy tool can answer "if I flip every game at
`chat:v5` to bundle X, which ones will refuse?" entirely client-side,
walk them through an intermediate bundle, and re-attempt.

## What would change our mind

The substrate gains an opinion about tags if and only if **every Pax-historia
schema-evolution flow turns out to need the same opinion** and we can
distill it into a primitive that's still operator-namespace-opaque. We don't
see this on the horizon.

## See also

- [`contract/bundle-compatibility.md`](../contract/bundle-compatibility.md)
  — the formal model
- [`vision/guarantees.md`](../vision/guarantees.md) #15 — bundle
  compatibility safety oracle
- [`subsystems/control-plane-admin-api.md`](../subsystems/control-plane-admin-api.md)
  — the three compat-tag observability endpoints
