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
| Substrate sees from it | A WebSocket connection bearing a JWT issued by the vercel backend |
| Substrate exposes to it | The WebSocket sub-protocol — see [`reference/ws-subprotocol.md`](../reference/ws-subprotocol.md) |
| Trust position | Untrusted by the substrate. The substrate trusts the JWT (signed by the vercel backend), not the frontend |

### Vercel backend

Pax-historia's Next.js server on Vercel. Owns identity, billing, the
token/credit ledger, the participation system, the moderation pipeline, game
metadata, presets, and the marketplace. Signs JWTs the substrate verifies.
Hosts URL services the substrate dispatches to. Issues admin calls into the
substrate. Receives history-tail / host-event traffic from the substrate.

| | |
|---|---|
| Lives in | Pax-historia repo (out of scope for this tree) |
| Talks to | The substrate via the admin REST API, by signing JWTs, and by serving URL service HTTP endpoints |
| Substrate sees from it | JWTs at WS handshake; admin calls; URL service responses; host-event POSTs |
| Substrate exposes to it | Admin REST API ([`reference/admin-api.md`](../reference/admin-api.md)), history stream, URL service callback envelope ([`reference/gateway-envelope.md`](../reference/gateway-envelope.md)), host-event POST endpoint |
| Trust position | Platform-trusted for admin calls (bearer token); URL services are over-the-wire equal to any other URL endpoint — the substrate just dispatches |

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
| Talks to | Bundle code (parent ↔ child IPC); the vercel backend (admin, URL services, host events); Rivet engine (vendored, opaque to overlays); Tigris (object storage); Redis (active-game directory + ephemeral state) |
| Owns | Compute plane (CPU, RAM, bandwidth, message rate, state/blob bytes, API rate, blob-key count), session transport, the IPC bus, lifecycle, history, bundle object storage, the kind→URL registry, the wire-grain record/replay primitives |
| Doesn't own | Anything billing-shaped, identity, auth flows, roles, metadata, presets, marketplace, social, anything user-facing in pixels |
| Trust position | Internally split — placement router, control plane, API gateway are platform-trusted; parent actor is shard-local-trusted; child process running creator JS is untrusted. See [`vision/trust-model.md`](trust-model.md) |

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
the substrate's child sandbox. The bundle is the unit; the author is a human
role.

## Implications for the architecture diagram

The canonical L1 diagram lives in
[`substrate-overview.md`](substrate-overview.md). It shows:

- The **vercel platform frontend wrapper** as a single client box on the
  left.
- The **substrate** as the central rectangle with its own internal pieces
  (router, parent, child, gateway, control plane, etc.).
- The **vercel backend** as a single counterparty box on the right.
- Tigris / Redis / vendored Rivet as substrate-internal infrastructure.

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
