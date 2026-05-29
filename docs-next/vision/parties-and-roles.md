# Parties and roles

> Layer: **Vision**

The substrate's universe has exactly three named parties. Use these names
everywhere. Don't introduce synonyms.

## The three parties

### Vercel platform frontend wrapper

The browser-facing application Pax-historia ships on Vercel. Renders games to
players, owns the user-visible UX, runs the Firebase auth flow, knows about
"sites" (beta vs production), and knows nothing about substrate internals.

| | |
|---|---|
| Lives in | Pax-historia repo (out of scope for this tree) |
| Talks to | The **vercel backend** for auth/billing/metadata; directly to the **substrate** over WebSocket for game data |
| Substrate sees from it | A WebSocket connection bearing a JWT the **placement router** signed after the vercel backend called `POST /placement` on its behalf |
| Substrate exposes to it | The WebSocket sub-protocol — see [`reference/ws-subprotocol.md`](../reference/ws-subprotocol.md) |
| Trust position | Untrusted by the substrate. The substrate trusts the WS JWT (signed by the router), not the frontend |

### Vercel backend

Pax-historia's Next.js server on Vercel. Owns identity, billing, the
token/credit ledger, the participation system, the moderation pipeline, game
metadata, presets, and the marketplace. **Authenticates to** the substrate's
placement and admin surfaces (it does **not** sign the WS JWT; the placement
router does that — see [`reference/jwt-claims.md`](../reference/jwt-claims.md)).
Provides opaque pass-through claims at placement time that the router embeds
verbatim. Hosts URL services the substrate dispatches to. Issues admin calls
into the substrate. Receives history-tail / host-event traffic from the
substrate.

| | |
|---|---|
| Lives in | Pax-historia repo (out of scope for this tree) |
| Talks to | The substrate via `POST /placement` (with pass-through claims), the admin REST API (bearer-token authed), and by serving URL service HTTP endpoints |
| Substrate sees from it | Authenticated placement requests; admin REST calls; URL service responses; host-event POSTs |
| Substrate exposes to it | Admin REST API ([`reference/admin-api.md`](../reference/admin-api.md)), history stream, URL service callback envelope ([`reference/gateway-envelope.md`](../reference/gateway-envelope.md)), host-event POST endpoint |
| Trust position | Platform-trusted for admin calls (bearer token); the WS JWT is signed by the router using `PAX_JWT_SECRET`, which the vercel backend does not hold; URL services are over-the-wire equal to any other URL endpoint — the substrate just dispatches |

The vercel backend is treated as an **opaque counterparty** for design
purposes. The substrate makes no assumptions about its internal structure
(what services compose it, how it persists data, whether it's monolith or
microservices). It assumes only the wire contracts in [`reference/`](../reference/).

### Substrate

This repo. The general-purpose-shaped backend platform. Runs untrusted creator
JavaScript per game, provides a small typed surface for player I/O and
external API calls, faithfully records what happened, and stays deliberately
ignorant of anything business-shaped (billing, identity, roles, metadata).

| | |
|---|---|
| Lives in | `pax-backend` (this repo) |
| Talks to | Bundle code (isolate ↔ Runner ↔ Broker bridge); the vercel backend (admin, URL services, host events); Tigris (object storage); Redis (active-game directory + ephemeral state) |
| Owns | Compute plane (CPU, RAM, bandwidth, message rate, state/blob bytes, API rate, blob-key count), session transport, the runtime bridge, lifecycle, the per-game state cache + atomic checkpoint, history, bundle object storage, the kind→URL registry, the wire-grain record/replay primitives |
| Doesn't own | Anything billing-shaped, identity, auth flows, roles, metadata, presets, marketplace, social, anything user-facing in pixels |
| Trust position | Internally split — placement router, control plane, API gateway are platform-trusted; the Broker is shard-trusted (sole credential holder); the Runner is credential-less; the game isolate running creator JS is untrusted. See [`vision/trust-model.md`](trust-model.md) |

## Why exactly three names

The current `README.md` mixes five overlapping roles ("operator," "host,"
"platform," "library," "developer") that all refer to one of these three.
Standardizing strips the ambiguity. Concretely:

| Old word | Means in practice | New canonical name |
|---|---|---|
| "Operator" | Whoever runs the substrate + writes URL services (= Pax-historia) | **Vercel backend** (for URL services) or **substrate** (for the substrate itself, when context is "the operator of the platform") |
| "Host" or "host product" | The Next.js Pax-historia server | **Vercel backend** |
| "Platform" (the trusted part) | The substrate | **Substrate** |
| "Library" | The substrate as the api-gateway component sees it | **Substrate** |
| "Developer" | A person writing a bundle | **Bundle author** (a person, not a party in the system) |
| "Creator" | Same | **Bundle author** |

A "bundle author" is a person, not a party — they write code that runs inside
a Runner's per-game isolate. The bundle is the unit; the author is a human
role.

## Implications for the architecture diagram

The canonical L1 diagram lives in
[`substrate-overview.md`](substrate-overview.md). It shows:

- The **vercel platform frontend wrapper** as a single client box on the
  left.
- The **substrate** as the central rectangle with its own internal pieces
  (router, Broker, Runner pool, gateway, control plane, etc.).
- The **vercel backend** as a single counterparty box on the right.
- Tigris / Redis as substrate-internal infrastructure.

Anything that wants to be a fourth party (e.g. "moderation team's
dashboard," "billing analytics service") is just the vercel backend
expressed at finer grain. The substrate doesn't see it.

## Single-tenant by design, general-purpose-shaped by discipline

There is exactly one vercel backend and one vercel platform frontend wrapper
that will ever talk to this substrate. We do not build multi-tenancy. But
**every substrate-internal interface is shaped as if multiple vercel
backends could exist**, because that constraint produced cleaner contracts.

If a doc here is tempted to add a `tenantId` field, a per-tenant config table,
or any other abstraction that only makes sense with multiple consumers — stop.
That's the wrong design force. The right design force is "would this be a
clean contract if there were a hundred vercel backends?" and the answer
informs the shape, not whether to ship the abstraction.

## The contract is generic; the party names are concrete

The substrate's contract surface ([`contract/`](../contract/),
[`reference/`](../reference/)) is shaped around generic primitives:
`gameId`, `playerId`, `bundle`, JWT, kind→URL registry, history events.
Nothing in the contract layer names Vercel.

These vision docs name `vercel backend` and `vercel platform frontend
wrapper` because Pax-historia is the substrate's only consumer today, and
abstract role names ("operator," "host product") produced ambiguity in
the legacy README. If a second consumer ever shows up — running on AWS, on
bare metal, anywhere — the contract surface drops in unchanged; only the
concrete party names in this layer need substitution.

So: "vercel backend" is shorthand for "the substrate's host backend
counterparty, which today is the pax-historia Next.js server on Vercel."
Future readers should mentally substitute their own host backend if reusing
the substrate, not edit the vocabulary.
