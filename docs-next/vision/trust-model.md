# Trust model

> Layer: **Vision**

The substrate has five trust positions. Every component, every
counterparty, every wire format inherits one of them. This page enumerates
each, the threat model, and the blast radius when a trust position is
violated. The shard is the interesting part: it is split into a
credential-holding **Broker** and a credential-less **Runner** so that the
ring actually running untrusted creator code holds nothing worth stealing.

## The five trust positions

| Position | Who | Implication of compromise |
|---|---|---|
| **Platform-trusted** | Placement router, control plane, API gateway | The substrate is compromised. All sessions, all bundles, all URL service traffic on the cluster |
| **Shard-trusted** | Broker on one shard | One shard is compromised: its hosted games' state, sessions, and shared shard credentials |
| **Credential-less** | Runner process hosting game isolates | The low-value *content* of that one Runner's co-tenant games. **No credential, no network, no identity authority** |
| **Untrusted** | Game isolate running creator JS | One game is compromised |
| **Wire counterparty** | Vercel backend, vercel platform frontend wrapper, URL services | Compromise is detectable from the substrate's side at message receipt; the substrate trusts JWTs and admin bearer tokens (cryptographically), not the counterparties themselves |

## Platform-trusted services

Three components, all in the orchestration plane:

### Placement router
- Verifies its own JWTs, signs new ones.
- Holds `PAX_JWT_SECRET` (HS256, 64 bytes).
- Speaks Redis to the active-game directory.
- Decides which shard a placement request lands on.

### Control plane
- Holds the admin bearer token.
- Owns admin REST (including time-travel view/restore).
- Writes bundles to Tigris.
- Streams history.
- Issues host events.

### API gateway
- Holds the URL service registry.
- Builds the canonical envelope.
- Records every wire-grain round trip.

Compromise scenario: if any of these is owned, the substrate is owned.
Defense-in-depth: all three are platform-trusted by code review, deploy
pipeline, secrets management (Infisical), and zone-scoped Fly tokens.
There is no in-band check that detects platform-trust compromise — the
substrate relies on the deploy chain.

## Shard-trusted: the Broker

Each shard machine runs one Broker process. It terminates player
WebSockets, owns sessions, enforces compute budgets, runs the per-game
state cache + atomic checkpoint flush to Tigris, proxies `c.api.invoke` to
the gateway, and writes history. It is the **sole holder of every shard
credential** (Tigris S3 keys, Redis URL, the JWT secret, URL-service auth)
and the sole network egress and identity authority on the shard.

The Broker is trusted by the Runners it supervises. It is not trusted by
other shards (each shard's Broker is independently trusted on its own
machine).

Compromise scenario: a compromised Broker could fake history, lie to URL
services about `connectedSessions`, accept arbitrary requests from Runners
without enforcing budgets, sign packets the substrate considers
authoritative, or read/write any state for its hosted games. Blast radius
is one shard's working set.

Defense:
- The Broker runs as its own supervised OS process with the credential
  boundary as its defining property.
- It talks to Tigris/Redis using credentials in Infisical-synced env, not
  per-game scoped.
- A compromised Broker cannot mutate another shard's games (their state is
  fenced by the conditional root PUT on `checkpointSeq`; see
  [`subsystems/state-store.md`](../subsystems/state-store.md)) nor the
  directory's view of which shard owns which game without its Redis
  credentials (which compromise itself implies).

## Credential-less: the Runner

Each shard runs a small pool of Runner processes, each hosting many game
isolates on one event loop. A Runner holds **no credentials, no network
access, and no identity authority**. Its only capability is "ask the
Broker to act on a game I'm assigned." It does **not** assert
`gameId` / `sessionId` / `connectedSessions` — the Broker stamps those
from its own session state and rejects any request for a game the Runner
is not assigned.

Compromise scenario — **a full native V8 escape inside a Runner**: the
attacker can read or cross-contaminate the low-value content of the games
on that one Runner. It **cannot** obtain any credential, cannot spend
money, cannot impersonate a player to a URL service (the Broker stamps
identity), and cannot reach other Runners or shards.

This residual risk is acceptable **only because the Runner is
credential-less** — that invariant is load-bearing and non-negotiable. A
normal JS-level misbehavior (infinite loop, OOM, throwing) is contained by
the isolate itself.

Blast radius of a native Runner escape: the content of that Runner's
co-tenant games (bounded by `K`, the isolates-per-Runner dial). No
credential, no other shard.

## Untrusted: the game isolate

Each game runs in its own `isolated-vm` isolate inside a Runner.

Constraints enforced from outside the isolate:
- **No network.** The isolate has no socket access. `c.api.invoke` is a
  bridge call to the Runner, which asks the Broker, which talks to the
  gateway.
- **No environment variables.** The isolate sees only what the Broker
  delivered at creation.
- **CPU/memory capped.** `isolated-vm` enforces a per-isolate memory cap;
  the per-handler timeout bounds CPU.
- **No filesystem.** No `fs` from inside the isolate.
- **No visibility between siblings.** Separate V8 heaps; one game's isolate
  cannot see a co-tenant's.

Compromise scenario: a bundle escapes its isolate (a known but rare
`isolated-vm` bug). It now runs inside the credential-less Runner process —
which is the position above. So the worst case of an isolate escape is
bounded by the Runner's own constraints: read its co-tenant games'
content, but reach no credential and no network.

Further compromise — escaping the Runner process itself — requires a
Node/V8 zero-day. We accept this as the security floor. See
[`why/why-isolated-vm.md`](../why/why-isolated-vm.md).

Blast radius of an in-isolate compromise via creator JS: **one game**.

## Wire counterparties

### Vercel platform frontend wrapper

The substrate trusts the JWT the frontend presents, not the frontend.

- The WS JWT is signed by the **placement router**, not by the vercel
  backend (see [`reference/jwt-claims.md`](../reference/jwt-claims.md)).
  The substrate verifies the signature against `PAX_JWT_SECRET`, which the
  router holds; the Broker verifies with the same key on WS accept.
- Substrate trusts `playerId` from the JWT subject (`sub`).
- Substrate trusts `gameId` from the JWT claims.
- Substrate trusts `traceId` and `runId` from JWT claims when present.

If the frontend is compromised, it can replay router-signed JWTs.
Defense: the JWT carries an expiry. The router issues short-TTL JWTs
(default 5 minutes). A stolen JWT is useful for the TTL window only.

A stolen JWT cannot let a player connect to a game they're not on the
`allowedPlayers` list for. Guarantee #2 (`allowed-only-connection`) closes
this regardless of JWT validity.

### Vercel backend

The substrate trusts the vercel backend for two distinct purposes:

1. **Placement authentication and pass-through claims.** The vercel
   backend authenticates to `POST /placement` (today via the Fly edge /
   vercel-backend proxy chain; the router itself does not currently
   enforce caller auth on this endpoint — that's a vercel-backend / Fly
   edge concern). The router takes the placement request's
   `(gameId, playerId, passthrough)` at face value and signs the WS JWT.
   A compromised vercel backend can therefore request JWTs for any
   `(playerId, gameId)` pair. Mitigation: substrate still gates on
   `allowedPlayers` (which the vercel backend is also authoritative for).
   So a fully compromised vercel backend can compromise its own
   substrate-facing surface, but no other party.
2. **Admin REST calls.** A bearer token. Compromise of the bearer token =
   compromise of the substrate's mutating surface (game lifecycle, bundle
   pointer flips, allowed-player mutations, host events, time-travel
   restore).

Note that **the WS JWT signing key (`PAX_JWT_SECRET`) is not held by the
vercel backend.** It's held by the placement router and the Brokers. This
keeps the signing capability inside one substrate-internal trust boundary;
the vercel backend authenticates and proxies, but does not sign.

The substrate-internal defense for both above: there isn't one. The vercel
backend is a trusted counterparty for these two purposes. If it's owned,
the system is owned.

This is a deliberate trade-off. The alternative — substrate-side
fine-grained capabilities for vercel-backend operations — would require
the substrate to model identity, which is the very thing this design
refuses to do.

### URL services

The substrate trusts URL services to the **maximum extent of what they
report back**. Specifically:

- Substrate POSTs the canonical envelope.
- URL service may compute anything, call anywhere, and respond.
- Substrate records the wire bytes verbatim.
- Substrate returns the response to the bundle verbatim.

The substrate does **not** trust URL services to enforce business rules on
its behalf. If a URL service is compromised and lies about, say, "this
player is a participant," the substrate doesn't know. That's a vercel
backend / URL service operational concern, not a substrate concern.

The substrate's defense is observational: the wire-grain record/replay
makes URL service compromise auditable after the fact.

## The threat model in one paragraph

> An attacker who controls the bundle code (i.e. an attacker is a bundle
> author who shipped malicious JS) is the primary threat model. They can do
> anything inside the per-game isolate; if they escape it they reach only a
> credential-less Runner and its co-tenant games' content; they cannot
> obtain a credential, make outbound calls except through the substrate's
> gateway, or lie about which sessions are connected to their game, because
> the substrate generates `sessionId`s and stamps `connectedSessions` from
> its own state, not from the bundle's claims. The vercel backend's URL
> services then have the information they need to refuse business
> operations the bundle is trying to abuse (e.g. billing for a
> disconnected player).

This is what makes the "no billing in the substrate" decision safe: the
substrate faithfully tells URL services who was where when, and URL
services do whatever billing rules they want.

## What the substrate doesn't try to defend against

- **Node/V8 zero-day inside a Runner process.** Accepted floor (still
  credential-less, so it stops at game content).
- **Compromised vercel backend or its admin bearer token.** The whole
  system depends on this trust position.
- **Compromised Fly platform** (Fly itself, Tigris itself, Redis itself).
  Out of scope.
- **DOS via legitimate-shaped traffic.** Compute budgets are per-game; a
  pathological bundle author who legitimately consumes 100% of their own
  game's allocation does not affect other games. Multi-game DOS (creating
  10k games to exhaust shard capacity) is a vercel-backend gating
  responsibility.
- **Side channels** (timing, cache, hardware). Out of scope for the
  substrate's threat model.

## Cross-references

- [`why/why-isolated-vm.md`](../why/why-isolated-vm.md) — the sandbox depth decision.
- [`why/why-broker-runner.md`](../why/why-broker-runner.md) — why the credential boundary sits between Broker and Runner.
- [`subsystems/broker.md`](../subsystems/broker.md) — what the Broker enforces vs trusts.
- [`subsystems/runner.md`](../subsystems/runner.md) — the Runner's isolation specifics.
- [`reference/jwt-claims.md`](../reference/jwt-claims.md) — the JWT contract between vercel backend and substrate.
