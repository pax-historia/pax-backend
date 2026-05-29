# JWT claims contract

> Layer: **Reference catalog**

The substrate's JWT is the trust bearer for every WebSocket connection.
It is signed by the placement router (with `PAX_JWT_SECRET`, HS256)
after a successful `POST /placement` call. The Broker verifies on the WS
handshake.

This page is the canonical JWT shape contract.

## Signing party

The placement router signs every JWT. The router gets the
`PAX_JWT_SECRET` from Infisical (synced to both `pax-backend-control`
and `pax-backend-shards` so the Broker can verify with the same key).

In production the vercel backend never signs JWTs — it relies on the
substrate's placement router for that. This keeps the JWT signing key
inside one trust boundary.

## Algorithm

**HS256** (HMAC SHA-256). Key length: 64 bytes. Rotation is operator-owned;
no in-band kid header (the substrate has one active key at a time).

## Claim set

```ts
interface SubstrateJwt {
  // Standard JWT claims
  iss: 'pax-backend-router';
  aud: 'pax-backend-shards';
  sub: string;                          // playerId
  iat: number;                          // ISO seconds, issued-at
  exp: number;                          // ISO seconds, expiry (typically iat + 300)
  jti: string;                          // UUID; one per signed JWT

  // Substrate-specific claims
  gameId: string;                       // the game this JWT permits a WS to
  shardId: string;                      // the shard the placement router chose
  traceId: string | null;               // W3C trace_id; for distributed tracing
  runId: string | null;                 // scenario-runner run id; null in production

  // Pass-through claims (vercel-backend-controlled)
  passthrough: Record<string, unknown>; // verbatim opaque blob the vercel backend supplied in the placement request body; embedded in the JWT by the router and signed as part of it
}
```

## Field ownership

| Claim | Set by | Verified by | Notes |
|---|---|---|---|
| `iss` | Router | Broker | Always `pax-backend-router` |
| `aud` | Router | Broker | Always `pax-backend-shards` |
| `sub` | Router (from placement request) | Broker | The `playerId` |
| `iat` | Router | Broker | Issued-at |
| `exp` | Router | Broker | Typically 5 minutes after `iat` |
| `jti` | Router | (not enforced; for vercel backend audit) | Unique per JWT |
| `gameId` | Router (from placement request) | Broker | Used to scope WS endpoint |
| `shardId` | Router | Broker | Cross-checks the WS URL is on the right shard |
| `traceId` | Router (from `traceparent` header on placement request) | Broker + every downstream span | W3C 16-byte hex |
| `runId` | Router (from placement request body) | Substrate-internal; for scenario-runner | Scenario-only; `null` in production |
| `passthrough` | Vercel backend (proxied through placement request body) | Bundle (in `onPlayerConnect.jwtClaims`) | Opaque |

## The pass-through claims

When the vercel backend wants to send opaque info to the bundle (e.g.
Firebase identity, role hints, channel info, user-experiment tags), it
includes a `passthrough` object in the placement request body:

```jsonc
POST /placement
{
  "gameId": "string",
  "playerId": "string",
  "passthrough": {
    "firebaseUid": "string",
    "firebaseEmail": "string",
    "userRoleHint": "participant",
    "experimentCohort": "beta-A"
  }
}
```

The router embeds `passthrough` verbatim in the JWT. The Broker forwards
the JWT claims (including `passthrough`) to the bundle's
`onPlayerConnect` handler as `jwtClaims`.

The substrate **does not interpret** `passthrough`. It's a vercel
backend / bundle private channel.

## Trust properties

A valid JWT means:

- The router accepted a `POST /placement` request for `(playerId,
  gameId)` and signed this JWT.
- The router validated the placement request's auth (currently:
  whatever auth the vercel backend's frontend-proxy provides at the
  router's edge — the substrate does not currently enforce caller
  auth on `POST /placement`; that's a vercel-backend / Fly edge
  concern).
- The JWT is not expired.

A valid JWT does **not** by itself authorize the WS connection. The
Broker ALSO checks:

- `gameId` in JWT matches the URL path.
- `shardId` in JWT matches this shard.
- `playerId ∈ allowedPlayers(gameId)` (guarantee #2 — this is the
  substrate's defense-in-depth).

So a stolen JWT for `(P1, G1)` doesn't let P1 connect to G2; doesn't
let P1 connect after P1 is removed from `allowedPlayers(G1)`; and
expires within minutes.

## Expiry

Default TTL: **5 minutes** between `iat` and `exp`. Short TTL is
deliberate — a stolen JWT has a small attack window.

Frontends that need a long-lived connection re-call `POST /placement`
proactively before the JWT expires (and re-establish WS with the new
JWT). Within a single WS connection's lifetime, the JWT's expiry is
**not checked again** — once the WS is open, the substrate trusts it
until close.

## Rotation

`PAX_JWT_SECRET` rotation is currently atomic-flip (no key-id grace
window). To rotate:

1. Generate a new 64-byte secret.
2. Update Infisical.
3. `fly secrets set` to both `pax-backend-control` and
   `pax-backend-shards`.
4. Restart both apps.

Any in-flight JWTs signed with the old secret are invalidated at the
restart boundary. Frontends re-place automatically.

A future enhancement could add `kid` header support for graceful
rotation; not in v1.

## What the bundle sees

In `onPlayerConnect`, the bundle receives:

```ts
onPlayerConnect(c, { playerId, sessionId, jwtClaims, connectedAt }) {
  // jwtClaims is the full JWT body as a JSON object, including:
  //   - iss, aud, sub, iat, exp, jti
  //   - gameId, shardId, traceId, runId
  //   - passthrough (verbatim from the vercel backend)
}
```

The bundle most commonly reads `jwtClaims.passthrough` — that's where
the vercel backend stuffs anything role-shaped or identity-shaped.

The URL service receives the same `jwtClaims` in
`context.triggeringJwtClaims` for `api.invoke` calls triggered by
`onPlayerMessage`.

## What about Firebase / vercel auth?

The substrate doesn't verify Firebase tokens or any other identity
provider's tokens. The vercel backend is responsible for:

1. Running its own Firebase auth flow with the user.
2. Deciding which `(gameId, playerId)` to allow this user to connect as.
3. Calling `POST /placement` on the substrate's router with
   `passthrough` containing whatever Firebase claims it wants to forward.

The substrate trusts the vercel backend's decisions. A compromised
vercel backend can sign placement requests for arbitrary
`(gameId, playerId)`; the substrate's `allowedPlayers` gate is the
last line of defense.

## Cross-references

- [`ws-subprotocol.md`](ws-subprotocol.md) — handshake and frame format
- [`placement-api.md`](placement-api.md) — `POST /placement` wire reference
- [`subsystems/placement-and-wake.md`](../subsystems/placement-and-wake.md) — placement flow
- [`subsystems/broker.md`](../subsystems/broker.md) — JWT verification on WS accept
- [`vision/trust-model.md`](../vision/trust-model.md)
- [`vision/guarantees.md`](../vision/guarantees.md) #2
