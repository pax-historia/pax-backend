# Trust model

> Layer: **Vision**

The substrate has four trust positions. Every component, every counterparty,
every wire format inherits one of them. This page enumerates each, the
threat model, and the blast radius when a trust position is violated.

## The four trust positions

| Position | Who | Implication of compromise |
|---|---|---|
| **Platform-trusted** | Placement router, control plane, API gateway | The substrate is compromised. All sessions, all bundles, all URL service traffic on the cluster |
| **Shard-local-trusted** | Parent actor on one shard | One shard is compromised. ~100 games |
| **Untrusted** | Child process running creator JS | One game is compromised |
| **Wire counterparty** | Vercel backend, vercel platform frontend wrapper, URL services | Compromise is detectable from the substrate's side at message receipt; the substrate trusts JWTs (cryptographically) and admin bearer tokens (cryptographically), not the counterparties themselves |

## Platform-trusted services

Three components, all in the orchestration plane:

### Placement router
- Verifies its own JWTs, signs new ones.
- Holds `PAX_JWT_SECRET` (HS256, 64 bytes).
- Speaks Redis to the active-game directory.
- Decides which shard a placement request lands on.

### Control plane
- Holds the admin bearer token.
- Owns admin REST.
- Writes bundles to Tigris.
- Streams history.
- Issues host events.

### API gateway
- Holds the URL service registry.
- Builds the canonical envelope.
- Records every wire-grain round trip.

Compromise scenario: if any of these is owned, the substrate is owned.
Defense-in-depth: all three are platform-trusted by code review, deploy
pipeline, secrets management (Infisical), and zone-scoped Fly tokens. There
is no in-band check that detects platform-trust compromise — the substrate
relies on the deploy chain.

## Shard-local-trusted: the parent actor

Each shard machine has a parent actor process. It is the IPC broker between
all child processes on that shard, owns sessions, enforces compute budgets,
writes history, and proxies `c.api.invoke` to the gateway.

The parent is trusted by every child it forks. It is not trusted by other
shards (each shard's parent is independently trusted on its own machine).

Compromise scenario: a compromised parent could fake history, lie to URL
services about `connectedSessions`, accept arbitrary IPC from children
without enforcing budgets, or sign packets the substrate considers
authoritative. Blast radius is ~100 games (one shard's working set).

Defense:
- Parent runs as a vendored Rivet actor with its own process boundary.
- Parent talks to Tigris using credentials in Infisical-synced env, not
  per-game scoped.
- A compromised parent cannot mutate the active-game directory's view of
  which shard owns which game without writing to Redis, which requires its
  Redis credentials (which compromise itself implies).

## Untrusted: the child process

Each game runs as a separate `node child_process` containing an
`isolated-vm` isolate that runs the bundle.

Constraints enforced from outside the child:
- **No network.** The child has no socket access. `c.api.invoke` is an IPC
  call to the parent, which then talks to the gateway.
- **No environment variables.** The child sees only the bootstrap message
  the parent sends.
- **CPU/memory capped.** `isolated-vm` enforces memory; the parent enforces
  CPU-ms-per-tick by timeout.
- **No filesystem.** The child has no `fs` access from inside the isolate.

Compromise scenario: a bundle can escape the isolate (a known but rare
`isolated-vm` bug). It now runs inside the Node child process. From there
it can:
- Make IPC calls to the parent claiming to be any channel.
- Read the bootstrap message (one-time, per-game scoped).
- *Not* talk to the network (no socket access in the child's process).
- *Not* read Infisical secrets (not in the child's env).

So the worst case of an isolate escape is "the bundle can lie about its
own IPC messages." The substrate's defense is:
- The parent stamps `gameId` and `sessionId` based on the child→parent
  process binding, not on what the child says.
- The parent rejects IPC messages whose channel name is outside the
  enumerated set.
- Compute budgets are tracked from the parent's side.

Further compromise — escaping the Node process itself — requires a Node
zero-day. We accept this as the security floor. See
[`why/why-isolated-vm-in-child.md`](../why/why-isolated-vm-in-child.md).

Blast radius of any in-substrate compromise via creator JS: **one game**.

## Wire counterparties

### Vercel platform frontend wrapper

The substrate trusts the JWT the frontend presents, not the frontend.

- The WS JWT is signed by the **placement router**, not by the vercel
  backend (see [`reference/jwt-claims.md`](../reference/jwt-claims.md)).
  The substrate verifies the signature against `PAX_JWT_SECRET`, which the
  router holds; the parent actor verifies with the same key.
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
   pointer flips, allowed-player mutations, host events).

Note that **the WS JWT signing key (`PAX_JWT_SECRET`) is not held by the
vercel backend.** It's held by the placement router and the parent actors.
This keeps the signing capability inside one substrate-internal trust
boundary; the vercel backend authenticates and proxies, but does not sign.

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

The substrate's defense is observational: the wire-grain record/replay makes
URL service compromise auditable after the fact.

## The threat model in one paragraph

> An attacker who controls the bundle code (i.e. an attacker is a bundle
> author who shipped malicious JS) is the primary threat model. They can do
> anything inside the per-game sandbox; they cannot affect other games; they
> cannot make outbound calls except through the substrate's gateway; they
> cannot lie about which sessions are connected to their game because the
> substrate generates `sessionId`s and stamps `connectedSessions` from its
> own state, not from the bundle's claims. The vercel backend's URL
> services then have the information they need to refuse business
> operations the bundle is trying to abuse (e.g. billing for a
> disconnected player).

This is what the README's §"Trust model" describes in a longer form. It's
what makes the "no billing in the substrate" decision safe: the substrate
faithfully tells URL services who was where when, and URL services do
whatever billing rules they want.

## What the substrate doesn't try to defend against

- **Node zero-day inside the child process.** Accepted floor.
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

- [`why/why-isolated-vm-in-child.md`](../why/why-isolated-vm-in-child.md) —
  the sandbox depth decision.
- [`subsystems/parent-actor.md`](../subsystems/parent-actor.md) — what the
  parent enforces vs trusts.
- [`subsystems/child-runner-sandbox.md`](../subsystems/child-runner-sandbox.md)
  — the child's isolation specifics.
- [`reference/jwt-claims.md`](../reference/jwt-claims.md) — the JWT contract
  between vercel backend and substrate.
