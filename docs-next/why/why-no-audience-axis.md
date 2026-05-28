# Why: no audience / cohort / channel axis as a substrate primitive

> Layer: **Why**

## Considered

A separate substrate-level axis for cohort-based admission and routing.
The proposal was an opaque `audienceTag` triple-set per bundle and shard:

- Each bundle declares `audienceTagsAllowed: string[]` (which audiences
  can connect) and `audienceTagsServed: string[]` (which audiences this
  bundle is meant for).
- Each shard declares `audienceTagsServed: string[]`.
- Each WS connection carries an `audienceTag` from the JWT.
- Substrate enforces both: (a) JWT's `audienceTag` is in
  `bundle.audienceTagsAllowed` at connect time; (b) bundle's
  `audienceTagsServed` is a subset of shard's `audienceTagsServed` at
  placement time.

The motivating use case was: "we want a beta site whose users connect
only to beta bundles on beta shards" — a coordinated rollout primitive.

## Why we said no

The proposed feature already exists by composition of two simpler
primitives the substrate already has:

### The routing half: bundle compatibility placement gate

A bundle declares `runtimeContractRequired: N+1`. The substrate has
shards at `runtimeContractsSupported: [N, N+1]` and shards at `[N-1, N]`.
The placement gate (guarantee #16) refuses to place that bundle onto an
old shard. So beta-only shards already exist as "shards that support a
newer contract range."

To stand up a beta pool: deploy 1-2 shards with the newer contract,
publish a bundle requiring the newer contract, pin specific games to
that bundle. Substrate enforces the placement gate; the new bundle can
only land on the new shards.

### The admission half: JWT claims + bundle code

The bundle's `onPlayerConnect` reads `jwtClaims` and decides whether to
engage. The vercel platform frontend wrapper passes whatever claim it
wants (`channel: 'beta'`, `flightId: 'experiment-42'`, anything). The
bundle either responds normally or sends a `ws.send` reply telling the
client to redirect / retry / show an error UI.

That's strictly more flexible than a substrate-enforced
`audienceTagsAllowed` because the bundle can implement arbitrary admission
policy (time windows, A/B test cohorts, manual allow-lists, geographic
restrictions).

### What we'd add by introducing audienceTag

The only thing audienceTag adds that bundle-code-via-JWT can't: a
**typed substrate-level rejection at WS handshake** instead of a
bundle-defined `ws.send` payload. The marginal value is a slightly
cleaner error code on the wire (`audienceMismatch` vs whatever the bundle
chooses).

That's not worth a new axis. The marginal admission cost (bundle's
`onPlayerConnect` doing one JWT-claim check) is microseconds. The bundle
gets to choose the failure UX. The substrate stays contract-narrow.

## What we'd add by introducing audienceTag (continued)

We'd also need:

- A fourth versioning axis in the substrate's contract (substrate ↔
  bundle, substrate ↔ URL service, kind name versioning, **and now
  audience**).
- Operator naming conventions for audience tags.
- Admin endpoints for audience-tag mutation, histogram, etc.
- Migration/transition tooling for audience changes.

All of which the substrate currently doesn't need.

## What would change our mind

We'd add an audienceTag axis if and only if:

1. Pax-historia's cohort-rollout flow turns out to require admission
   rejection at substrate (WS-handshake) layer rather than at bundle
   layer for reasons we don't anticipate today (e.g. compliance, fraud).
2. The bundle-code-via-JWT pattern proves too leaky in practice — bundles
   forget to gate, or the gate logic becomes a frequent source of bugs.

Neither is on the horizon.

## See also

- [`contract/bundle-compatibility.md`](../contract/bundle-compatibility.md)
  — beta/canary recipe by composition
- [`vision/non-goals.md`](../vision/non-goals.md)
- [`subsystems/placement-and-wake.md`](../subsystems/placement-and-wake.md)
