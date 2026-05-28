# `orchestration/` — what runs OUTSIDE shards

**Deploys to `pax-backend-control`.** Co-located on one machine in v1; split
out as evidence demands (see [plan](../README.md) §"Scale target (v1)").

## Contents

| Path | What it is |
|---|---|
| `placement-router/` | Rust crate. HTTP placement + signed JWT; active-game directory; capacity push-in from shards; the `runtimeContractRequired ∈ shard.runtimeContractsSupported` placement gate (guarantee #16). **No WS data path.** Ported from [pax-sharded-spike/orchestration/router-placement/](../../pax-sharded-spike/orchestration/router-placement/), then extended. |
| `control-plane/` | TS. Shard registry, drain, admin REST surface (see [plan](../README.md) §"Admin surface"). Owns `POST /admin/bundles/:bundleName` (manifest validation), `POST /admin/games/:id/bundle` (the flip gate, guarantee #15), session admin endpoints, history query. |
| `api-gateway/` | TS. URL-per-kind registry, library-defined context envelope, wire-grain record/replay, api-invocations-per-min budget (guarantee #5). The substrate's only egress to operator-owned URL services. |
| `url-services/` | First-party reference URL services: `echo/`, `delay/`, `http-fetch/`, `mock-ai.v1/`. One folder per service. |

The router's data path is deliberately the smallest thing in this zone: it
serves placement HTTP, signs JWTs, and pushes capacity. It does **not** sit
in the WS path, the blob path, or `api.invoke` (the gateway is a separate
request/response surface, not a WS proxy).

## Sub-layout conventions

```
placement-router/src/
  gates/          # one file per placement gate (runtime-contract.rs, capacity.rs)
  jwt.rs
  directory.rs    # active-game directory (Redis)
  registry.rs     # shard registry reader
  main.rs

control-plane/src/
  admin/<resource>/<action>.ts  # e.g. admin/games/flip-bundle.ts,
                                #      admin/games/snapshot.ts,
                                #      admin/bundles/upload.ts
  app.ts

api-gateway/src/
  registry.ts          # kindName → URL table
  envelope.ts          # X-Gateway-Envelope-Version + context-envelope builder
  record-replay.ts     # wire-grain fingerprinting + replayCoverageGap
  budgets.ts           # api-invocations-per-min compute-plane budget
  app.ts

url-services/<kind>/   # one folder per reference URL service
  src/...              # whatever the service needs internally
```

**Soft rules:** as in [`../runtime/README.md`](../runtime/README.md) —
one-file-per-kind is a target, `_internal/` is the escape hatch, kind-folders
get created when their first file lands.

Smoke today ships `placement-router/` only. `control-plane/`,
`api-gateway/`, and `url-services/` are zone slots that land in M2+.
