# Boundaries and layers

> Layer: **Vision**

The substrate sits at a junction between three things: a browser (vercel
platform frontend wrapper), a server (vercel backend), and creator code
(bundles inside the substrate's sandbox). It owns specific pieces of that
junction and deliberately leaves others to other layers.

This page is the map. Every other doc in `docs-next/` is consistent with it.

## The four layers, top to bottom

```
┌────────────────────────────────────────────────────────────────────┐
│ 4. Vercel platform frontend wrapper                                │
│    Browser app. Firebase auth. Site UX. Renders games.             │
│    Out of this repo.                                               │
└────────────────────────────────────────────────────────────────────┘
                              │
                              │ WS (with router-signed JWT)
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ 3. Substrate (this repo)                                           │
│    Core: parent, child, gateway, control plane, router.            │
│    Owns: compute plane, sessions, transport, history, bundles.     │
│    Knows nothing about business semantics.                         │
└────────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP gateway envelope
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ 2. URL services (where business semantics live)                    │
│                                                                    │
│   2a. Substrate-shipped reference services                         │
│       echo, delay, http.fetch, mock-ai.v1                          │
│       (deploy with the gateway; documented in subsystems/)         │
│                                                                    │
│   2b. Operator overlay patterns                                    │
│       Worked examples of billing, participation, moderation,       │
│       projection sync. Documented in operator-overlays/.           │
│       The substrate does not own these; they're patterns the       │
│       vercel backend uses.                                         │
│                                                                    │
│   2c. Vercel-backend-implemented URL services                      │
│       ai.chat.v1, flag.search.v1, participation.v1, etc.           │
│       Live in the Pax-historia repo. Substrate just dispatches.    │
└────────────────────────────────────────────────────────────────────┘
                              │
                              │ Admin REST + URL service callbacks
                              ▼
┌────────────────────────────────────────────────────────────────────┐
│ 1. Vercel backend                                                  │
│    Pax-historia Next.js. Identity, billing, presets, metadata,     │
│    marketplace. Hosts URL services. Authenticates to placement     │
│    and admin; the router signs the WS JWT.                         │
│    Out of this repo.                                               │
└────────────────────────────────────────────────────────────────────┘
```

Layer 3 (substrate) is what this repo builds. Layer 2b (operator overlay
patterns) is what `docs-next/operator-overlays/` documents — *patterns*,
not code. Layers 1, 2c, and 4 live in the Pax-historia repo.

## The substrate's responsibility line

Top edge — substrate ↔ frontend (WS):

| Owns | Does not own |
|---|---|
| WS handshake, JWT verification, session generation, message framing, idempotency, force-disconnect on roster mutation, ws.send fan-out | What the client UI looks like, what the client sends |

Right edge — substrate ↔ URL service (HTTP gateway envelope):

| Owns | Does not own |
|---|---|
| Kind→URL registry, context envelope build, request fingerprinting, wire-grain record/replay, api-invocations-per-min budget, replayCoverageGap hard-fail | URL service implementations, the shape of `args`/`result`, vendor SDK choices, retries/streaming inside URL services, billing math, participation logic |

Bottom edge — substrate ↔ vercel backend (admin REST + history pull):

| Owns | Does not own |
|---|---|
| Admin REST surface (games, allowed players, bundles, shards, API kinds, history, sessions, compat tags), bundle upload pipeline, history stream, host-event delivery (`wakeOnDelivery`) | Who issues admin calls when, what triggers bundle uploads, the host's own ledger / projection tables / moderation workflows |

Internal — substrate ↔ creator JS (IPC):

| Owns | Does not own |
|---|---|
| IPC channel set, lifecycle hook contract, payload schemas, compute budget enforcement, error code taxonomy | The bundle's logic, the bundle's choice of state shape, the bundle's choice of `c.api.invoke` kinds |

## The boundary in one sentence (per layer pair)

- **Frontend ↔ substrate:** the substrate is the only thing the frontend
  trusts about who's connected to what game.
- **Substrate ↔ URL service:** the substrate is opinion-free about what the
  URL service does; it dispatches, records, and returns.
- **Substrate ↔ vercel backend:** the vercel backend is the source of truth
  for identity/billing/policy; the substrate is the source of truth for
  sessions/compute/transport.
- **Substrate ↔ bundle:** the substrate runs the bundle inside a sandbox,
  meters its resources, transports its messages, persists its state, and
  records what it did. The bundle decides what to do.

## Why the substrate doesn't own URL services in general

A URL service is "any HTTP endpoint at a registered URL." That means:

- The four substrate-shipped reference services (`echo`, `delay`,
  `http.fetch`, `mock-ai.v1`) are URL services that happen to be deployed
  with the gateway. The substrate ships them so the harness has fixtures
  and the hello-world bundles have something to call.
- Pax-historia's `ai.chat.v1`, `flag.search.v1`, `moderation.audit.v1`,
  `participation.v1`, `projection.sync.v1` are URL services that happen to
  live in the vercel backend. The substrate dispatches to them without
  knowing they exist beyond a row in its registry.

Both go through the same envelope, the same record/replay, the same compute
budget, the same `kindUnknown` / `providerError` / `replayCoverageGap` error
taxonomy. The substrate doesn't draw a line between "ours" and "theirs."
**The line is a registry lookup and an HTTP call. Both sides comply with
[`reference/gateway-envelope.md`](../reference/gateway-envelope.md).**

The substrate does, however, ship reference services as Layer 2a so the test
harness, the hello-world bundles, and the local-mac dev loop don't require
the vercel backend to be running. See
[`subsystems/api-gateway.md`](../subsystems/api-gateway.md) for the deployment
mechanics.

## Why operator overlays are docs, not code

Layer 2b in the diagram is the trickiest one to keep straight. The substrate
contract is opinion-free about billing/participation/moderation. But every
URL service that implements those patterns runs into the same structural
questions:

- How do I authenticate that an `api.invoke` came from a real session and
  not a compromised bundle replaying arbitrary `playerId`s?
- How do I implement "only bill connected players" on top of
  `connectedSessions[]`?
- How do I distinguish a spectator from a participant when the substrate
  has no role concept?
- How do I make my URL service's behavior testable?

The answer to each of these is a *pattern*: a way to compose substrate
primitives (`connectedSessions`, `triggeringSessionId`,
`triggeringJwtClaims`, host-event channel) into the desired business
behavior. The patterns are reusable across URL service kinds; they're not
unique to `ai.chat.v1`.

So `operator-overlays/` documents those patterns as prose, with the canonical
implementations living in the vercel backend (or as reference fixtures in
`examples/url-services/billing-mock.v1/`). The substrate's contract docs
([`contract/`](../contract/)) reference them without depending on them.

## Multi-tenancy is a design force, not a feature

The substrate is shipped to one consumer (Pax-historia). It is designed *as
if* multi-tenancy were a runtime feature, because that constraint produced
cleaner contracts (the kind→URL registry, the opaque compat tags, the
opinion-free admin surface). But there is no per-tenant config table, no
`tenantId` field, no per-tenant isolation. If a doc here is about to
introduce one, that's the wrong design force; see
[`parties-and-roles.md`](parties-and-roles.md) §"Single-tenant by design".
