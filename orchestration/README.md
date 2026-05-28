# `orchestration/` — what runs OUTSIDE shards

**Deploys to `pax-backend-control`.** Co-located on one machine in v1; split
out as evidence demands (see [plan](../README.md) §"Scale target (v1)").
CI rejects PRs that touch both `runtime/**` and `orchestration/**`.

## Contents

| Path | What it is |
|---|---|
| `placement-router/` | HTTP placement + signed JWT; active-game directory; capacity push-in from shards; the `runtimeContractRequired ∈ shard.runtimeContractsSupported` placement gate (guarantee #16). **No WS data path.** Ported from [pax-sharded-spike/orchestration/router-placement/](../../pax-sharded-spike/orchestration/router-placement/), then extended. |
| `control-plane/` | Shard registry, drain, admin REST surface (see [plan](../README.md) §"Admin surface"). Owns `POST /admin/bundles/:bundleName` (manifest validation), `POST /admin/games/:id/bundle` (the flip gate, guarantee #15), session admin endpoints, history query. |
| `api-gateway/` | URL-per-kind registry, library-defined context envelope, wire-grain record/replay, api-invocations-per-min budget (guarantee #5). The substrate's only egress to operator-owned URL services. |
| `url-services/` | First-party reference URL services: `echo`, `delay`, `http.fetch`, `mock-ai.v1`, plus a `billing-mock.v1` *reference* (worked example of how an operator might layer billing on top of session observability; not part of the substrate's contract). |

The router's data path is deliberately the smallest thing in this zone: it
serves placement HTTP, signs JWTs, and pushes capacity. It does **not** sit in
the WS path, the blob path, or `api.invoke` (the gateway is a separate
request/response surface, not a WS proxy).
