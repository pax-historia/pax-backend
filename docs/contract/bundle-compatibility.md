# Bundle compatibility

The substrate enforces exactly two compatibility relations and stays
opinion-free about everything else:

1. **Bundle ↔ blob** (data-shape). Each game carries a single opaque
   `blobCompatTag` (namespace-level — one tag per game's blob namespace,
   not per-key); each bundle declares `compatTagProduced` and
   `compatTagsAccepted` in its manifest. The substrate refuses any
   bundle-pointer flip or cold wake where `game.blobCompatTag ∉
   bundle.compatTagsAccepted`. **Set membership only — no opinion about
   what tags "mean".** Per-key versioning inside the blob namespace is the
   bundle's problem, not the substrate's.
2. **Bundle ↔ shard** (runtime contract). Each bundle declares
   `runtimeContractRequired: number`; each shard declares
   `runtimeContractsSupported: [min, max]`. The placement router refuses
   to route a bundle onto a shard whose range doesn't include the bundle's
   required contract.

These map to Strong Platform Guarantees #15 and #16. They ship as oracles in
the scenario-runner's first-party oracle library.

## Three versioning axes the substrate carries

| Axis | Boundary | Mechanism |
|---|---|---|
| A. Substrate ↔ bundle wire | Child ↔ parent actor | `runtimeContractRequired: int` + `runtimeContractsSupported: [min,max]` |
| B. Substrate ↔ URL-service wire | Gateway ↔ URL service | `X-Gateway-Envelope-Version: 2` header |
| C. Bundle ↔ URL-service application | Creator code ↔ URL service | Version baked into kind name (`ai.chat.v1`, `ai.chat.v2`) |

There is **no fourth axis** (no per-channel `v:` envelopes; no substrate-level
"audience" / "channel" tag). The plan documents why.

## Worked tag patterns

These are operator naming patterns, not substrate semantics:

| Pattern | Example |
|---|---|
| Linear | v1 bundle writes `game:v1`; v2 accepts `["game:v1", "game:v2"]` and writes `game:v2`. |
| Bridge | A temporary bridge bundle accepts old and new tags, rewrites blobs, then operators flip to a narrow bundle that accepts only the new tag. |
| Multi-family | A bundle accepts `["inventory:v3", "profile:v5"]` only if its own code knows how to read both families from the blob payload. |
| Fork | A forked game line uses a new prefix such as `arena:v1`; old games cannot wake on it unless the bundle lists the old tag. |
| Fingerprint | A bundle writes `sha256:<schema-hash>` when operators want tag names derived from schema artifacts. |

The substrate only asks one question: is the current blob tag a member of the
bundle's accepted set? If yes, wake/flip may proceed. If no, the substrate
refuses and returns the accepted set so operator tooling can plan a bridge.

## Gate payloads

Flip refusals return `409 compatTagOutOfRange` with:

```json
{
  "blobCompatTag": "game:v1",
  "bundleCompatTagsAccepted": ["game:v2"]
}
```

Placement refusals return `contractOutOfRange` when no registered shard range
contains the bundle's `runtimeContractRequired`. Successful placement responses
include `runtimeContractRequired` and the selected shard's
`runtimeContractsSupported` range so the scenario-runner can record and verify
the decision.
