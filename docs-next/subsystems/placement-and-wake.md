# Placement and wake

> Layer: **Subsystem**

The placement router and the wake flow form the substrate's "where does
this game run, and how does it start" story. This page describes both
end-to-end.

## Purpose

Decide, on every wake, which shard a game runs on. Enforce the runtime
contract placement gate (guarantee #16). Issue signed JWTs so the
vercel platform frontend wrapper can connect WS directly to the parent
actor on the chosen shard.

## Owns

- The placement HTTP API (`POST /placement`).
- The active-game directory (Redis) — `gameId → shardId` mapping plus
  capacity push from each shard.
- JWT signing (HS256 with `PAX_JWT_SECRET`).
- The placement gate logic: filter shards by health, capacity,
  acceptance flag, freshness, and runtime contract range.
- The host-event wake path: when the control plane delivers a
  `wakeOnDelivery: true` host event to a sleeping game, the router is
  the entry point for the placement decision.

## Doesn't own

- The WS data path. The router is **HTTP-only**. Clients connect WS
  directly to the parent actor.
- The bundle store. The router knows nothing about bundle binaries; it
  consults the control plane's bundle metadata for `runtimeContractRequired`.
- Per-game state. The router doesn't read or write `c.state`/`c.blob`.
- Game creation/deletion. That's control plane (`POST /admin/games`,
  `DELETE /admin/games/:id`).

## Inputs

| Source | What |
|---|---|
| Vercel platform frontend wrapper | `POST /placement` with `{ gameId, playerId, ... }` plus a Firebase-bearing auth context (proxied via vercel backend before this hop, in production) |
| Vercel backend (host events) | `POST /admin/games/:id/host-event` with `wakeOnDelivery: true` (routed through control plane, which triggers a placement on the router's behalf) |
| Each shard | Capacity push to Redis every N seconds: `{ shardId, currentGameCount, lastSeenAt, status, runtimeContractsSupported }` |
| Control plane | Bundle metadata lookup (`runtimeContractRequired`) at placement time |

## Outputs

| Destination | What |
|---|---|
| Vercel platform frontend wrapper | Signed JWT + `wsUrl` pointing at the chosen shard's WS endpoint |
| Control plane (history sink) | `placement.accepted` and `placement.refused` history events |
| Itself (Prometheus) | `pax_router_*` metrics (placement latency, gate rejections, contention) |

## Placement decision flow

```
1. Receive POST /placement { gameId, playerId, runId?, traceId? }
2. Look up gameId in active-game directory.
   - If found and the shard is still healthy:
     - Return the existing shardId (sticky placement).
   - If found but the shard is unhealthy or draining:
     - Treat as fresh placement.
   - If not found:
     - Fresh placement.
3. Look up the game's currentBundleName and the bundle's runtimeContractRequired.
4. Filter shards:
   a. status == healthy
   b. acceptingWakes == true
   c. lastSeenAt within freshness window (30s default)
   d. runtime_contract_required ∈ runtimeContractsSupported
   e. currentGameCount < shardCapacity
5. If no eligible shards:
   - If some shards exist but all fail (a)/(b)/(c)/(e): respond noEligibleShards (503).
   - If the failure was specifically the contract gate (d): respond contractOutOfRange (409).
6. Pick a shard by capacity score.
7. Write a placement claim to Redis (atomic SETNX or equivalent).
8. Sign a JWT with { gameId, playerId, traceId, runId?, sessionTtl, shardId }.
9. Return { wsUrl, jwt }.
10. Emit placement.accepted history event.
```

## Strong guarantee implementation

### #16 — Placement contract safety

Implemented by step 4(d). The router refuses to route a game onto a
shard whose `runtimeContractsSupported` range does not include
`bundle.runtimeContractRequired`. Refusal is `409 contractOutOfRange`
with the offending values in the body.

The oracle (`placement-contract-safety.mts`) walks `placement.accepted`
events and asserts that each one's recorded `runtimeContractRequired`
falls within the shard's recorded `runtimeContractsSupported` range.
Any violation is a release blocker.

### #2 — Allowed-only connection (partial)

The router does not check `allowedPlayers`. That's the parent actor's
job at WS-accept (the substrate is defense-in-depth: even a stolen JWT
won't let an unauthorized player connect). The router signs JWTs for
any `(gameId, playerId)` pair the vercel-backend-proxied request asks
for; the parent rejects at handshake.

The substrate accepts this layering: the router stays stateless about
who can play what game.

## Wake reasons triggered by the router

- **Player reconnect** during sleep-grace → no new placement; existing
  shard already hosts the game.
- **Player reconnect** after grace expired → new placement; child
  process boots; wake reason is `cold-restart-from-storage`.
- **Host event with `wakeOnDelivery: true` to sleeping game** → control
  plane triggers a placement-router call; child boots; wake reason is
  `cold-restart-from-storage` followed by an `onHostEvent` delivery.
- **Cross-shard migration** (planned, e.g. drain) → control plane
  initiates; placement happens via the same code path; wake reason is
  `cold-restart-from-storage`.

## Capacity push

Each shard pushes a capacity row to Redis every N seconds (default
2s). The row contains:

```
{
  shardId,
  status: 'healthy' | 'draining' | 'unhealthy',
  acceptingWakes: bool,
  currentGameCount: int,
  lastSeenAt: ISO timestamp,
  runtimeContractsSupported: [min, max]
}
```

The router considers a shard fresh if `lastSeenAt` is within the
freshness window (30s default). Stale shards are excluded from
placement.

## Stickiness

A game's previous shard is preferred on re-placement if still healthy
and accepting. Stickiness reduces cold-load churn on `c.state`.

If the previous shard is unhealthy/draining/full, the router picks a
fresh shard; the next `onWake` sees `cold-restart-from-storage` and
hydrates from Tigris.

## Failure model

| Failure | Recovery |
|---|---|
| Router process dies | Stateless; restart loses nothing. Redis directory persists |
| Redis unavailable | Router responds `503 directoryUnavailable`; vercel platform frontend wrapper retries with backoff |
| No eligible shards | `503 noEligibleShards`; vercel platform frontend wrapper displays a "capacity exceeded" UX |
| Contract gate refuses | `409 contractOutOfRange` (deterministic; not retryable until cluster gains an eligible shard) |
| Control plane bundle lookup fails | `503 bundleMetadataUnavailable`; retryable |

## Trust position

**Platform-trusted.** The router holds `PAX_JWT_SECRET` and signs JWTs the
parent actor will trust. If the router is compromised, the substrate's
WS-handshake authentication is compromised.

## Observability surface

| Signal | Owner |
|---|---|
| Metrics: `pax_router_placement_*` (duration, gate rejections, decision lock wait/hold, capacity row staleness) | Self; Prometheus `:9080/metrics` |
| Logs: structured JSON via `tracing` with `RUST_LOG_FORMAT=gcp` | Self → stdout → Vector |
| Traces: OTel spans `router.placement` with `tracing::instrument` on every handler | Self → OTLP/gRPC → Vector |
| History events: `placement.accepted`, `placement.refused` written to control plane via short HTTP call | Control plane is the writer; router is the source |

## End-state contract

A consumer (the vercel platform frontend wrapper, or the control plane
in the host-event case) can rely on:

- **`POST /placement` returns within 100 ms p99** in steady state.
- **The returned `wsUrl` is good for the JWT's TTL** (default 5 min).
- **A successful placement is recorded to history** before the response
  returns.
- **A refusal cites the specific gate** that failed (`contractOutOfRange`,
  `noEligibleShards`, etc.).

## Cross-references

- [`contract/bundle-compatibility.md`](../contract/bundle-compatibility.md)
  — the placement gate's contract side
- [`reference/admin-api.md`](../reference/admin-api.md) — placement API
- [`reference/jwt-claims.md`](../reference/jwt-claims.md) — JWT shape
- [`subsystems/parent-actor.md`](../subsystems/parent-actor.md) — what
  the parent does on WS-accept
- [`vision/guarantees.md`](../vision/guarantees.md) #16
- [`subsystems/control-plane-admin-api.md`](../subsystems/control-plane-admin-api.md)
  — host-event wake handoff
