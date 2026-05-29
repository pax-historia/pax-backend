# Substrate overview

> Layer: **Vision**

## What the substrate is

A general-purpose-shaped backend platform that:

1. **Runs untrusted creator JavaScript** inside a per-game sandbox.
2. **Connects browsers to that JS** over WebSocket, with substrate-owned
   session lifecycle and substrate-verified JWTs.
3. **Dispatches outbound calls** from creator JS to operator-defined URL
   services through a single typed channel (`c.api.invoke`), with rich
   session context attached and every round trip recorded at wire grain.
4. **Faithfully records** what happened — every channel call, every session
   transition, every wire-grain API round trip, every shard event — into a
   single observable history.
5. **Owns the compute plane** (CPU, RAM, bandwidth, message rate,
   state/blob bytes, blob keys, API rate) and enforces per-game budgets.
6. **Owns bundle storage** — both the binary blob and its manifest metadata.
7. **Stays deliberately ignorant** of everything business-shaped: billing,
   identity, roles, metadata, marketplace, social, moderation policy,
   spectator rules.

That's the whole substrate. Everything else either lives in the **vercel
backend** (identity, billing, presets, metadata, URL service implementations)
or in **operator overlays** (worked patterns the vercel backend happens to
use; see [`operator-overlays/`](../operator-overlays/)).

## The single architecture diagram

```mermaid
flowchart TB
  frontend["Vercel platform frontend wrapper<br/>(browser; Firebase auth; site UX)"]

  subgraph substrate ["Substrate"]
    direction TB
    subgraph orchestration ["Orchestration plane (platform-trusted)"]
      router["Placement router<br/>HTTP placement + signed JWT"]
      control["Control plane<br/>Admin REST + history<br/>+ bundle storage"]
      gateway["API gateway<br/>kind→URL registry + envelope<br/>+ wire-grain record/replay"]
    end

    subgraph shard ["Shard machine"]
      direction TB
      broker["Broker (1 per shard)<br/>(shard-trusted; all credentials)<br/>WS, sessions, identity stamping,<br/>compute budgets, state cache +<br/>atomic checkpoint, history writer"]
      runners["Runner pool<br/>(credential-less; no network)<br/>many game isolates per Runner<br/>isolated-vm; capped"]
      broker <-->|"async bridge"| runners
    end

    refsvc["First-party reference URL services<br/>(echo, delay, http.fetch, mock-ai.v1)"]
  end

  vbackend["Vercel backend<br/>(Pax-historia Next.js)<br/>Identity, billing, presets,<br/>URL service implementations,<br/>history tail consumer"]

  tigris[("Tigris<br/>state root · c.blob · bundles · history")]
  redis[("Redis<br/>active-game directory + ephemeral")]

  frontend -->|"HTTP placement"| router
  router -->|"router-signed JWT + wsUrl"| frontend
  frontend -->|"WS + JWT (Fly-proxy pinned)"| broker
  broker <-->|"checkpoint reads/writes"| tigris
  broker -.->|"capacity push"| redis
  router <-->|"directory + score"| redis
  broker -->|"c.api.invoke"| gateway
  gateway -->|"HTTP POST + envelope"| refsvc
  gateway -->|"HTTP POST + envelope"| vbackend
  vbackend -->|"POST /placement<br/>(authenticated; pass-through claims)"| router
  vbackend -->|"admin REST + host-event POST"| control
  control -->|"writes bundles to"| tigris
  control -->|"history tail / poll"| vbackend
```

Three points to notice in the diagram:

- The substrate has **no WebSocket data path through the router**. The router
  is HTTP-only. Clients connect WS directly to the Broker on the shard they
  were placed on (the Fly proxy pins the connection to that machine). That
  keeps the router stateless and the data plane short.
- **All substrate-internal durable storage (the per-game state root,
  optional `c.blob`, bundles, history archives) sits in Tigris.** Redis is
  for ephemeral, low-value data (directory rows, capacity push, sessions
  in-flight). There is no per-shard durable volume in the state path —
  durability is Tigris-canonical and committed at checkpoints.
- **The vercel backend hosts URL services**, but the substrate ships
  first-party reference services co-located with the gateway. From the
  gateway's perspective every URL service is the same: a `kindName → URL`
  registry lookup followed by an HTTP POST under a fixed envelope.

## How the pieces compose into the contract

The substrate's value proposition rests on three intertwined properties:

### 1. Authoritative session observability

Every WebSocket connection gets a substrate-generated `sessionId`. That id is:

- Unforgeable (clients can't pick their own).
- Opaque (the substrate has no opinion on its structure).
- Cluster-wide unique.
- Stable for the connection lifetime.

The `sessionId` flows through every lifecycle hook (`onPlayerConnect`,
`onPlayerMessage`, `onPlayerDisconnect`), every `c.api.invoke` context
envelope (`triggeringSessionId` plus a `connectedSessions[]` snapshot of
every open session at dispatch time), and every session-bracketing history
event (`session.opened`, `session.closed`).

This is what lets the vercel backend implement arbitrarily sophisticated
billing, participation, role, and anti-fraud logic on top of the substrate
without the substrate having any vocabulary for any of it: the vercel
backend's URL services see, on every call, exactly who was connected when,
with which JWT claims. They make the trust decisions. See
[`operator-overlays/billing-policy.md`](../operator-overlays/billing-policy.md).

### 2. Wire-grain record and replay

Every `c.api.invoke` round trip is recorded as `(fingerprint, raw outbound
envelope, raw inbound response)` at the gateway↔URL-service boundary. Two
consequences:

- **Production replay.** Re-run a historical session against a new substrate
  build with URL service responses frozen. The runtime, gateway logic, and
  creator code re-execute; the only frozen variable is what came back from
  the URL service. Differences attribute to substrate code, not to vendor
  drift.
- **Scenario fixtures.** A scenario's `api-responses/` directory is a set of
  recorded responses keyed by fingerprint. The scenario-runner short-circuits
  HTTP dispatch in replay mode. Missing fixture coverage is a hard fail
  (`replayCoverageGap`), not a fall-through to live calls.

### 3. Small contract, testable in full

The contract surface is intentionally narrow:

- 7 lifecycle hooks ([`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md))
- 8 compute budgets ([`contract/compute-budgets.md`](../contract/compute-budgets.md))
- 17 strong platform guarantees ([`vision/guarantees.md`](guarantees.md))
- 3 versioning axes ([`contract/bundle-compatibility.md`](../contract/bundle-compatibility.md))
- 1 external API channel ([`contract/external-api-channel.md`](../contract/external-api-channel.md))
- 1 state object + an optional keyed-blob escape hatch ([`contract/storage.md`](../contract/storage.md))

Every guarantee maps to an oracle that reads pure history. Every oracle is
run by the scenario-runner on every release. See
[`subsystems/scenario-runner.md`](../subsystems/scenario-runner.md).

## Scale target

The proof milestone is **1k concurrent games across 10 shard machines**.
The substrate's interesting properties (router throughput, per-shard
hibernation, cross-shard migration, redeploy safety, history completeness
under load) are all measurable at this size. If it works cleanly, we add
shards and density.

Density is the headline of the runtime: collapsing per-game Node
duplication into **many game isolates per credential-less Runner** is a
~7-10× density win for typical games (a loaded game is ~1 MB of isolate vs
~36 MB of Node process). Combined with the cost model of the storage
design — idle games write nothing, mutating games cost one root PUT per
checkpoint — this is what opens the path from ~10k toward ~100k concurrent
without a central write head. See
[`why/why-broker-runner.md`](../why/why-broker-runner.md) and
[`why/why-tigris-canonical.md`](../why/why-tigris-canonical.md).

Initial Fly footprint:

- **10 shard machines** on `pax-backend-shards`, each running one Broker
  plus a small Runner pool. No per-shard durable volume in the state path
  — state is Tigris-canonical and committed at checkpoints; working set,
  not lifetime game count, drives the resident footprint.
- **1–2 control + gateway machines** on `pax-backend-control` co-locating
  the placement router, control plane, API gateway, and first-party
  reference URL services. Split out as evidence demands.
- **Scenario-runner driver machines on demand** on `pax-backend-driver`.

No in-app Postgres. The substrate has no ledger.

## What the substrate is not

A storytelling platform. A billing system. A credit store. A payment
processor. A Pax-branded anything. A multi-tenant service. A frontend.

See [`vision/non-goals.md`](non-goals.md) for the closed list.
