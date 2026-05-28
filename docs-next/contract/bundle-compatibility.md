# Bundle compatibility

> Layer: **Contract**

The substrate enforces exactly two compatibility relations and stays
opinion-free about everything else.

1. **Bundle ↔ blob** (data-shape).
2. **Bundle ↔ shard** (runtime contract).

These map to strong platform guarantees #15 and #16.

## The two relations

### Bundle ↔ blob (Axis C / data-shape)

Each game carries a single opaque `blobCompatTag: string` (namespace-level
— one tag per game's blob namespace, not per-key). Each bundle declares
in its manifest:

```ts
{
  compatTagProduced: string,        // what the bundle writes on sleep
  compatTagsAccepted: string[]      // what its onWake can read
}
```

Rules:

- `compatTagsAccepted` must include `compatTagProduced` (a bundle must be
  able to read what it writes).
- The substrate refuses any flip or cold wake where
  `game.blobCompatTag ∉ bundle.compatTagsAccepted`.
- Tags are opaque strings. **The substrate has zero vocabulary about
  "game type," "schema family," "data version," "newer," or "older."**
  It only checks set membership.
- Any structure on tag names is vercel-backend convention.

See [`why/why-opaque-compat-tags.md`](../why/why-opaque-compat-tags.md).

### Bundle ↔ shard (runtime contract)

Each bundle declares `runtimeContractRequired: number` — a single
integer naming the substrate-runtime surface (channels, IPC, lifecycle
hooks, gateway envelope) it compiled against. Each shard ships
`runtimeContractsSupported: [min, max]` integer range baked into its
image.

Rules:

- The placement router refuses to route a game onto a shard whose range
  does not include the bundle's `runtimeContractRequired`.
- Integer-linear because there is exactly one substrate runtime
  evolving in one direction.
- Channel payloads carry no in-band version field — the contract version
  is the single source of truth and dispatch happens before any payload
  is parsed.

## Manifest schema

```ts
interface BundleManifest {
  compatTagProduced: string;
  compatTagsAccepted: readonly string[];
  runtimeContractRequired: number;
}
```

Validation rules (enforced on `defineBundle()` call, on
`POST /admin/bundles/:bundleName` upload, and on every cold wake):

- `compatTagProduced` is a non-empty string.
- `compatTagsAccepted` is a non-empty string array.
- `compatTagsAccepted` includes `compatTagProduced`.
- `runtimeContractRequired` is a positive integer.

## Enforcement gates

The substrate has four gates that consume these fields. All four are
testable from history (guarantees #15 and #16) and all four ship as
oracles.

| Gate | Where it fires | Rule | Failure response |
|---|---|---|---|
| **Upload gate** | `POST /admin/bundles/:bundleName` | Manifest validates per schema above | `400 manifestInvalid` with details |
| **Flip gate** | `POST /admin/games/:id/bundle` | `game.blobCompatTag ∈ newBundle.compatTagsAccepted` | `409 compatTagOutOfRange` with `{ blobCompatTag, bundleCompatTagsAccepted }` |
| **Cold-wake gate** | Shard, before invoking `onWake` | Same check as flip; defense-in-depth | Wake refused; history records `bundle.coldWake.rejected` |
| **Placement gate** | Placement router | `bundle.runtimeContractRequired ∈ shard.runtimeContractsSupported` | `409 contractOutOfRange` |

## What the substrate enables on top

Because the tag is opaque and the substrate only does set membership,
vercel-backend tooling can encode any schema-evolution policy without
substrate changes:

| Pattern | Example |
|---|---|
| **Linear** | `"historia:v1"` → `"historia:v2"` → `"historia:v3"`; each bundle declares `compatTagsAccepted: ["v_N-2","v_N-1","v_N"]` |
| **Bridge** | A temporary bridge bundle accepts old and new tags, rewrites blobs, then operators flip to a narrow bundle that accepts only the new tag |
| **Multi-family** | `"chat:v3"` and `"strategy:v7"` coexist; bundles declare disjoint accepted sets; cross-family flips refused by name |
| **Branching** | `"chat:v5-stable"` and `"chat:v5-experimental"` coexist; a recombining bundle accepts both |
| **Fork** | `"arena:v1"` accepts `"chat:v9"` to migrate users into a new family |
| **Content hashing** | `"sha256:abc123..."` tag names computed from schema artifacts |

The substrate doesn't know any of these are happening. It just checks
set membership.

## Helping the vercel backend plan migrations

Because the substrate has no opinion about tag relationships, it exposes
the current tag population for client-side planning:

| Endpoint | Returns |
|---|---|
| `GET /admin/games/compat-tags` | Histogram, e.g. `{ "historia:v3": 120, "historia:v4": 800 }` |
| `GET /admin/games/by-compat-tag/:tag` | Paginated cursor list of games at a tag |
| `GET /admin/games/:id/bundle-compat?bundleName=...` | Dry-run of the flip gate; returns the would-be 409 body or `{ ok: true }`, no side effects |

With these three, a deploy tool can answer "if I flip every game at
`historia:v3` to bundle X, which ones will refuse?" entirely
client-side, walk them through an intermediate bundle, and re-attempt.

## Migration code lives inside the bundle

When `onWake` fires with `blobCompatTag !== bundleCompatTag`, the
bundle's own code transforms the blob and proceeds. Bundle authors
choose how far back to support by widening `compatTagsAccepted`; the
substrate enforces whatever floor the manifest declares.

See [`lifecycle-and-wake.md`](lifecycle-and-wake.md) for the on-wake
migration pattern.

## Three versioning axes

The substrate carries exactly three independent version identifiers:

| Axis | Boundary | Mechanism | Substrate opinion |
|---|---|---|---|
| **A. Substrate ↔ bundle** | Child (bundle JS) ↔ parent actor | `runtimeContractRequired: int` (bundle) + `runtimeContractsSupported: [min,max]` (shard); placement gate | Single linear evolution |
| **B. Substrate ↔ URL service** | Gateway ↔ URL service | `X-Gateway-Envelope-Version: 2` HTTP header | Single linear evolution |
| **C. Bundle ↔ URL service application** | Bundle code ↔ URL service application logic | Version baked into kind name (`ai.chat.v1`, `ai.chat.v2`) | Opaque (substrate just looks up the string) |

What's deliberately absent: a fourth "audience" axis (see
[`why/why-no-audience-axis.md`](../why/why-no-audience-axis.md)) and
per-channel `v:` envelopes (Axis A subsumes them).

## Beta / canary rollouts (vercel-backend-driven)

Beta and canary channels are not a substrate primitive. They compose
from per-game bundle pinning plus the existing contract placement gate.

The recipe (5 steps):

1. **Stand up beta-capable shards.** Deploy 1–2 shards with
   `runtimeContractsSupported: [N, N+1]` while existing shards stay at
   `[N-1, N]`. The cluster has a small "newest" pool.
2. **Publish a beta bundle.** Upload a bundle with
   `runtimeContractRequired: N+1` and whatever `compatTagsAccepted`
   covers the games to migrate. The placement gate now prevents this
   bundle from being placed on the older shards.
3. **Vercel backend decides which games get the beta bundle.** Per-user
   opt-in, manual operator selection, A/B cohort — whatever. The vercel
   backend calls `GET /admin/games/:id/bundle-compat` to pre-check, then
   `POST /admin/games/:id/bundle` to flip. Substrate validates the
   compat-tag gate.
4. **Roll forward.** To promote beta to general: upgrade more shards
   to `[N, N+1]`, flip more games.
5. **Roll back or sunset.** To abort beta: flip affected games back
   to the regular bundle (subject to the compat-tag gate). To fully
   sunset old contract: bump all shards to `[N+1, N+2]`, drain remaining
   contract-N-only games naturally.

## Rolling shard deploys

When shards on runtime contract `N` and `N+1` coexist during a rolling
deploy, the placement router restricts bundles with
`runtimeContractRequired: N+1` to N+1 shards. Bundles with
`runtimeContractRequired ≤ N` place on either. Drain-the-old completes
when all `N`-only games have slept naturally.

The "don't accidentally route a new-only bundle onto an old shard"
property is enforced by the placement gate, not by deploy choreography.
Operators don't have to time bundle pointer flips around shard
rollouts. The same property protects bundle rollbacks: a bundle pinned
to an older contract is always placeable as long as one in-range shard
exists.

## Cross-references

- [`why/why-opaque-compat-tags.md`](../why/why-opaque-compat-tags.md)
- [`why/why-no-audience-axis.md`](../why/why-no-audience-axis.md)
- [`vision/guarantees.md`](../vision/guarantees.md) #15, #16
- [`subsystems/placement-and-wake.md`](../subsystems/placement-and-wake.md)
- [`subsystems/control-plane-admin-api.md`](../subsystems/control-plane-admin-api.md)
- [`subsystems/bundle-storage.md`](../subsystems/bundle-storage.md)
- [`reference/admin-api.md`](../reference/admin-api.md)
