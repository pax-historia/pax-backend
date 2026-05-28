# Placement API

> Layer: **Reference catalog**

The placement HTTP API is the substrate's only public non-WS surface. The
vercel platform frontend wrapper calls `POST /placement` to obtain a WS
URL and a signed JWT; the control plane calls it (substrate-internally)
to trigger wakes for `wakeOnDelivery: true` host events.

This page is the canonical wire reference. The placement-decision logic
lives in [`subsystems/placement-and-wake.md`](../subsystems/placement-and-wake.md);
the JWT contract in [`jwt-claims.md`](jwt-claims.md); the WS handshake
in [`ws-subprotocol.md`](ws-subprotocol.md).

## Endpoint

The placement router is the only consumer-facing HTTP endpoint outside
of the admin REST surface and the per-shard WS endpoints. It does **not**
live under `/admin/` because it is not a privileged mutation surface — it
serves authenticated placement requests proxied from the vercel backend.

```
POST  <router-host>/placement
```

## Authentication

The router's placement endpoint expects the caller to be authenticated
upstream. In the production topology, the vercel platform frontend wrapper
calls a vercel-backend proxy (which authenticates the player via Firebase
or similar), which then forwards the request to the placement router over
a private network path.

The router itself does **not** verify the caller's identity beyond the
network-level guarantee of that proxy chain. This is documented as a
v1 stance in [`vision/trust-model.md`](../vision/trust-model.md): the
substrate treats `POST /placement` callers as platform-trusted because
the network path is platform-controlled. The router signs the WS JWT
using `PAX_JWT_SECRET`, which the vercel backend does **not** hold.

A future revision may add an explicit substrate-side caller-auth header
(e.g. a router-issued bearer). It is not currently required.

## Request

```http
POST /placement
Content-Type: application/json
traceparent: 00-<trace_id>-<span_id>-01   (optional W3C trace context)

{
  "gameId": "string",
  "playerId": "string",
  "runId": "string" | undefined,
  "passthrough": { ... } | undefined
}
```

### Fields

| Field | Required | Notes |
|---|---|---|
| `gameId` | yes | Cluster-wide unique game identifier; created via `POST /admin/games` |
| `playerId` | yes | The player whose session this JWT will authorize. Substrate uses this verbatim; the vercel backend has already authenticated the player upstream |
| `runId` | no | Scenario-runner run identifier. Pass-through for test/staging scoping; the substrate embeds it into the JWT `runId` claim. Production callers MUST omit this — `runId` is scenario-only (see [`jwt-claims.md`](jwt-claims.md)) |
| `passthrough` | no | An opaque JSON object the vercel backend supplies for the bundle and URL services to read. The router does not inspect it; it embeds it verbatim into the JWT's `passthrough` claim and signs the JWT as one unit. Bundles read it via `onPlayerConnect.jwtClaims.passthrough` |
| `traceparent` header | no | W3C trace context. If absent, the router generates a fresh `trace_id` |

## Response — success

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "wsUrl": "wss://shard-N.pax-backend-shards.fly.dev/ws/<gameId>",
  "jwt": "<HS256 signed token>"
}
```

| Field | Notes |
|---|---|
| `wsUrl` | The fully-qualified WS endpoint on the chosen shard. The frontend opens a WebSocket to `<wsUrl>?token=<jwt>` (the JWT travels as a query-string parameter, not a header — browser WS APIs do not support custom request headers) |
| `jwt` | HS256-signed substrate JWT. Default TTL 5 minutes from `iat`. See [`jwt-claims.md`](jwt-claims.md) for the full claim set |

The JWT contains the chosen `shardId`; the parent actor on the receiving
shard cross-checks it against its own shard identity at handshake time
(see [`ws-subprotocol.md`](ws-subprotocol.md)).

## Response — refusal

The router refuses placement with one of the following typed errors:

| Status | Code | Meaning |
|---|---|---|
| `409` | `contractOutOfRange` | The game's bundle has `runtimeContractRequired = R`, but no eligible shard's `runtimeContractsSupported` range contains `R`. The body includes `{ required, eligibleRanges: [[min, max], ...] }` so the caller can decide whether to wait, redeploy, or downgrade. Deterministic — not retryable until cluster gains an eligible shard. (Guarantee #16.) |
| `503` | `noEligibleShards` | At least one shard exists with the right contract range, but none are currently healthy + accepting wakes + within freshness window + below capacity. Retryable with backoff |
| `503` | `directoryUnavailable` | Redis active-game directory is unreachable. Retryable |
| `503` | `bundleMetadataUnavailable` | Control plane bundle metadata lookup failed. Retryable |
| `404` | `gameNotFound` | `gameId` does not exist (or has been deleted). Not retryable until the game is recreated |
| `400` | `placementRequestMalformed` | Body schema invalid (missing `gameId` / `playerId`, wrong types). Not retryable until the caller fixes the request |

Error body shape:

```jsonc
{
  "error": "<code>",
  "detail": { ... opaque diagnostic fields ... }
}
```

## Internal callers

The placement endpoint is also called substrate-internally — by the
control plane — to wake sleeping games for delivery of host events with
`wakeOnDelivery: true`. Internal callers use the same wire shape; the
control plane authenticates over the Fly internal network the same way
parents push capacity rows to Redis. See
[`subsystems/control-plane-admin-api.md`](../subsystems/control-plane-admin-api.md)
§"Host events".

## Stickiness

The router prefers the game's previous shard if the directory shows a
healthy, fresh, accepting-wakes shard already hosting this `gameId`. This
reduces `c.state` cold-load churn. If the previous shard fails any of
the gating predicates, a fresh shard is picked; the resulting wake reason
on the new shard is `cold-restart-from-storage` (see
[`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md)).

Sticky placement is **not** a substrate guarantee — sleeping games are
not pinned to historical shards (see
[`why/why-tigris-canonical.md`](../why/why-tigris-canonical.md)). It is a
cost optimization the router applies opportunistically.

## End-state contract

A caller of `POST /placement` can rely on:

- **`POST /placement` returns within 100 ms p99** in steady state.
- **The returned `wsUrl` is good for the JWT's TTL** (default 5 min).
- **A successful placement is recorded to history** before the response
  returns (`placement.accepted`).
- **A refusal cites the specific gate** that failed via `error` code.
- **The JWT is signed with `PAX_JWT_SECRET`** which the parent actor on
  the chosen shard verifies with the same key. The vercel backend does
  not hold this key.

## Cross-references

- [`jwt-claims.md`](jwt-claims.md) — JWT shape
- [`ws-subprotocol.md`](ws-subprotocol.md) — what happens after the
  frontend opens the WS
- [`subsystems/placement-and-wake.md`](../subsystems/placement-and-wake.md) —
  placement decision logic and capacity push
- [`subsystems/control-plane-admin-api.md`](../subsystems/control-plane-admin-api.md) —
  host-event wake handoff
- [`vision/trust-model.md`](../vision/trust-model.md) — caller-auth stance
- [`vision/guarantees.md`](../vision/guarantees.md) #16
- [`error-codes.md`](error-codes.md) — full error taxonomy
