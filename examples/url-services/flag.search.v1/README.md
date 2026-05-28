# `flag.search.v1`

> **Status: schema-only spec.** Part of the historia-default proof (see
> [`docs-next/proofs/historia-default.md`](../../../docs-next/proofs/historia-default.md)).
> No live HTTP server runs for the proof — bundle calls are replayed from
> canned `api-responses` fixtures via the scenario-runner's existing
> replay-mode short-circuit. Production paxhistoria's
> [`/api/flags/published/get-published-flags`](../../../../paxhistoria/app/api/flags/published/get-published-flags/route.ts)
> stays where it is.

URL service kind `flag.search.v1` is the operator-owned flag retrieval
endpoint the [`historia-default`](../../bundles/historia-default/) bundle
calls during jump-forward when a workflow needs an entity flag (for
newly-formed nations, conquered regions, custom entities, etc.).

The substrate forwards the standard gateway envelope per
[`docs-next/contract/external-api-channel.md`](../../../docs-next/contract/external-api-channel.md)
§"API gateway envelope" and records the wire-grain round trip. Everything
inside `args` and `result` is opaque to the substrate.

## Args

```ts
type FlagSearchV1Args = {
  query: string;
  sort?:
    | "best_match_retrieval_document"   // primary mode the bundle uses
    | "best_match_semantic_similarity"
    | "closest_image_phash"
    | "newest" | "oldest" | "most_net_likes";
  limit?: number;                      // default 10, max 50
  minNetLikes?: number;                // filter
  statusFilter?: "approved" | "any";   // filter
  yearRange?: { from?: number; to?: number };
  author?: string;
  incrementUseCount?: boolean;         // for analytics; default false
};
```

The bundle's jump-forward workflow today uses
`{ sort: "best_match_retrieval_document", query: "<entity description>",
minNetLikes: -4, statusFilter: "approved", incrementUseCount: true,
limit: 2 }`.

## Result

```ts
type FlagSearchV1Result =
  | { ok: true;
      flags: Array<{
        id: string;
        title: string;
        description?: string;
        imageUrl: string;
        author?: string;
        netLikes?: number;
        year?: number;
      }>; }
  | { ok: false;
      errorCode: "queryRejected" | "embeddingFailed" | "providerError";
      detail?: unknown; };
```

## Trust gates

None billing-shaped. The flag store is operator-owned content; reads are
cheap and don't bill any user. The service may rate-limit per `gameId` if
desired, but that's URL-service policy.

## Implementation notes (reference, not part of the proof)

Production paxhistoria uses Postgres HNSW vector indexes (one per sort
mode) + Google text-embedding for semantic queries; `lib/db/queries/published-flags.ts`
is the canonical source. Image pHash search uses a separate L2 + Hamming
re-rank path. For the proof, none of this runs — canned `api-responses`
fixtures supply realistic flag lists.

## Authoring fixtures for scenarios

Place canned responses in
`examples/bundles/historia-default/scenarios/<scenario>/fixtures/api-responses/`,
using the shared fixture format in [`../README.md`](../README.md). Suggested
coverage:

- A typical "find a flag for this country" response with 1–2 results.
- An empty-result response (for scenarios that test the bundle's
  fallback path).
- A `queryRejected` error response (for scenarios that test the bundle's
  error handling).

The scenario-runner hard-fails with `replayCoverageGap` on missing
fixtures.
