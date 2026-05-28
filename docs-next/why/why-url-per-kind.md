# Why: URL-per-kind, not embedded RPC

> Layer: **Why**

## Considered

Five alternative shapes for the substrate's external API channel:

1. **Embedded RPC handlers.** Bundles call `c.api.invoke('ai.chat.v1', args)`;
   the substrate dispatches to a handler implementation that's compiled
   into the substrate binary. New kinds require substrate redeploys.
2. **gRPC.** Each kind exposes a strongly-typed gRPC service; the substrate
   generates clients from protobuf schemas.
3. **Substrate-validated args/result.** The substrate registers each kind
   with a JSON schema; it validates inputs before dispatch and outputs
   before return.
4. **Per-kind plugin architecture.** Operators ship a binary plugin per
   kind that loads into the gateway process.
5. **URL-per-kind.** Each kind is registered as `kindName → URL`. The
   substrate POSTs to the URL with a canonical envelope and returns the
   response verbatim. The thing at the URL is opaque to the substrate.

We chose option 5.

## Why we said no to options 1–4

### Why not embedded RPC

- **Each new kind ships with the substrate.** Adding `ai.chat.v2` requires
  a substrate redeploy. The substrate's release cadence becomes the kind
  registry's release cadence.
- **Kind implementations have full substrate process access.** A buggy
  kind handler can crash the gateway. A malicious kind handler is
  catastrophic.
- **No physical kind separation.** Every kind shares the substrate's
  compute pool. Hot kinds and cold kinds can't scale independently.

### Why not gRPC

- **Schema coupling.** The substrate would need to know about every kind's
  protobuf schema. New schemas would require substrate codegen + redeploy.
- **The substrate doesn't care what `args` look like.** Why validate?
  The URL service can validate on its own side; the substrate dispatches
  bytes.
- **Tooling overhead.** gRPC adds protoc, codegen pipelines, schema
  registries. The substrate's value proposition doesn't include any of
  that.

### Why not substrate-validated args/result

- **The substrate would have to track schemas per kind.** That's a new
  registry the substrate maintains, separate from the kind→URL registry.
- **Schema mismatches manifest as substrate errors instead of URL service
  errors.** A bundle that calls `ai.chat.v1` with the wrong `args` shape
  would get a `schemaInvalid` from the substrate instead of a typed
  error from the URL service. That's harder to debug because the
  substrate has less context than the URL service.
- **It forces the substrate to interpret `args`.** The whole point of
  staying opaque to `args` is that the substrate has no opinion. Once
  it validates, it has an opinion.

### Why not plugins

- **Plugin loading is a giant security surface.** Per-kind plugins
  running inside the gateway process is just embedded RPC with extra
  ceremony.
- **Crash isolation.** A plugin OOM kills the gateway.
- **Versioning chaos.** Plugin ABI evolution becomes its own contract
  the substrate has to maintain.

## Why URL-per-kind

The substrate becomes a routing fabric:

```
c.api.invoke('ai.chat.v1', args)
  → gateway looks up 'ai.chat.v1' → 'https://vbackend.vercel.app/api/ai-chat-v1/invoke'
  → gateway POSTs the canonical envelope
  → gets a 200 OK back
  → returns the response verbatim to the bundle
```

The thing at the URL can be:

- A Node service on the same Fly app (reference services like `echo.v1`).
- A vercel-backend Next.js route handler.
- A serverless function on a third party.
- A Rust service in a different region.
- Anything at all that speaks the canonical HTTP envelope.

The substrate doesn't care. The contract is:

- One header: `X-Gateway-Envelope-Version: 2`.
- One body shape: `{ args, context: { gameId, sessionId, ... } }`.
- One response shape: `{ result }` or `{ error, detail? }`.

Everything else — `args` schema, `result` schema, retries, streaming
inside the URL service, vendor SDK choice, caching, billing math — is the
URL service's problem.

### What we get

- **The substrate's release cadence is decoupled from the kind registry.**
  Adding `ai.chat.v2` is a vercel-backend deploy + a `POST /admin/api-kinds`
  admin call. No substrate redeploy.
- **Kind versioning is operator-namespace.** `ai.chat.v1` and
  `ai.chat.v2` are two distinct registered names. The substrate doesn't
  even know they're related. The vercel backend can do whatever rollout
  it wants (split traffic, deprecate, fork families) without library
  changes.
- **Replay is meaningful.** Wire-grain recording at the HTTP boundary
  lets the scenario-runner replay any historical session against a new
  substrate build with URL service responses frozen. The substrate's
  bug surface and the URL service's bug surface can be tested
  independently.
- **Physical separation.** Hot kinds and cold kinds can move to different
  hosts (different Fly apps, different regions, different runtimes)
  without library changes.
- **Crash isolation.** A URL service that 500s, hangs, or returns garbage
  affects only that call. The substrate maps to `providerError` and the
  bundle handles it.

## What we give up

- **No substrate-side schema enforcement.** A bundle that calls
  `ai.chat.v1` with malformed `args` doesn't get a substrate-side error;
  it gets whatever the URL service returns (usually a 400).
- **Each kind round-trips HTTP.** Latency is one network hop higher than
  embedded RPC. At v1 scale (1k concurrent games), this is dwarfed by
  the URL service's own work (LLM call, DB read, etc.).
- **The kind registry is one config table.** A misconfigured URL fails
  loudly (`kindUnknown` or `providerError`); the substrate has no
  per-kind health checks beyond the natural failure of dispatch.

## What would change our mind

We'd reconsider if:

1. A kind shape emerges where the HTTP-envelope round trip is so frequent
   and so latency-critical that the per-call HTTP overhead dominates the
   URL service's own work. (Not seen for Pax-historia's planned kinds.)
2. The vercel backend's URL service authoring overhead becomes a real
   friction point and a substrate-shipped framework would be cheaper.
   (Possible long-term; would be additive, not a replacement.)

## See also

- [`contract/external-api-channel.md`](../contract/external-api-channel.md)
- [`reference/gateway-envelope.md`](../reference/gateway-envelope.md)
- [`operator-overlays/url-service-authoring.md`](../operator-overlays/url-service-authoring.md)
- [`subsystems/api-gateway.md`](../subsystems/api-gateway.md)
