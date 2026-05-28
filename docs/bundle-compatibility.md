# Bundle compatibility

> Stub. See [plan README](../README.md) §"Bundle compatibility" for the full
> model with worked examples (linear / multi-family / branching / forking /
> fingerprinting).

The substrate enforces exactly two compatibility relations and stays
opinion-free about everything else:

1. **Bundle ↔ blob** (data-shape). Each blob carries an opaque `compatTag`;
   each bundle declares `compatTagProduced` and `compatTagsAccepted` in its
   manifest. The substrate refuses any bundle-pointer flip or cold wake
   where `blob.compatTag ∉ bundle.compatTagsAccepted`. **Set membership
   only — no opinion about what tags "mean".**
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
| B. Substrate ↔ URL-service wire | Gateway ↔ URL service | `X-Gateway-Envelope-Version: 1` header |
| C. Bundle ↔ URL-service application | Creator code ↔ URL service | Version baked into kind name (`ai.chat.v1`, `ai.chat.v2`) |

There is **no fourth axis** (no per-channel `v:` envelopes; no substrate-level
"audience" / "channel" tag). The plan documents why.
