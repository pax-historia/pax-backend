# Authoring URL services

> Layer: **Operator overlay**

This is a pattern, not a substrate primitive. The substrate dispatches
to URL services via the canonical envelope; what they *do* is the
operator's concern. This page is the playbook for writing one.

The substrate's contract for URL services is the gateway envelope at
[`reference/gateway-envelope.md`](../reference/gateway-envelope.md). The
rest of this page is conventions, not contract.

## Anatomy of a URL service

A URL service is an HTTP endpoint at a registered URL that:

1. Accepts a POST with `Content-Type: application/json` and the
   substrate's canonical envelope body.
2. Reads the `X-Gateway-Envelope-Version` header to know which envelope
   schema to parse.
3. Parses `args` (operator-defined) and `context` (substrate-defined).
4. Does the work.
5. Returns either `200 OK { result: ... }` or `4xx/5xx { error,
   detail? }`.

That's it. The substrate doesn't care if the URL service is Node, Rust,
a Vercel edge function, a serverless route, or a static-response stub.

## Minimum-viable URL service (Node sketch)

```ts
import { z } from 'zod';
import express from 'express';

const ContextSchema = z.object({
  gameId: z.string(),
  triggeringSessionId: z.string().nullable(),
  triggeringJwtClaims: z.record(z.unknown()).nullable(),
  connectedSessions: z.array(z.object({
    sessionId: z.string(),
    playerId: z.string(),
    connectedAt: z.number(),
  })),
  bundleName: z.string(),
  bundleCompatTag: z.string(),
  runId: z.string(),
  traceId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
});

const ArgsSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })),
  billToPlayer: z.string(),
});

const app = express();
app.use(express.json({ limit: '5mb' }));

app.post('/invoke', async (req, res) => {
  const envelopeVersion = req.header('x-gateway-envelope-version');
  if (envelopeVersion !== '2') {
    return res.status(400).json({ error: 'envelopeVersionUnsupported' });
  }

  const ctx = ContextSchema.safeParse(req.body.context);
  if (!ctx.success) {
    return res.status(400).json({ error: 'invalidContext', detail: ctx.error });
  }

  const args = ArgsSchema.safeParse(req.body.args);
  if (!args.success) {
    return res.status(400).json({ error: 'invalidArgs', detail: args.error });
  }

  // -- Trust check (see "Trust patterns" below) --
  const isParticipant = ctx.data.connectedSessions.some(
    s => s.playerId === args.data.billToPlayer
  );
  if (!isParticipant) {
    return res.status(403).json({ error: 'playerNotConnected' });
  }

  // -- Do the work --
  const result = await callTheVendor(args.data.messages);

  return res.status(200).json({ result });
});

app.listen(5001);
```

The substrate sees `200 OK { result }` and returns it verbatim to the
bundle.

## Trust patterns

URL services have a small set of well-defined trust questions, each
with a standard answer using substrate primitives:

### "Did this call really come from a connected session?"

Look at `context.connectedSessions`. If the player you care about isn't
in the snapshot, the bundle is trying to act on a player who isn't
there. Refuse with `playerNotConnected` (or whatever code).

### "Did this call come from a real player's input vs a bundle background task?"

`context.triggeringSessionId` is non-null only when the call was
triggered by `onPlayerMessage`. Lifecycle-triggered calls (`onWake`,
`onCapacityWarning`, etc.) have `triggeringSessionId: null`.

### "Is this player a participant or a spectator?"

The substrate has no role concept. Call your own participation service
(see [`participation-and-roles.md`](participation-and-roles.md)) or
read `context.triggeringJwtClaims` (the vercel backend may have stuffed
role info into the JWT).

### "Has this call already been billed?"

`context.idempotencyKey`, if the bundle supplied one, is the bundle's
dedup hint. The URL service may also dedupe on its own (`requestId` from
the header is unique per call).

### "Is this call from a bundle version I expect?"

`context.bundleName` and `context.bundleCompatTag` identify the bundle.
A URL service can refuse calls from unknown bundles.

### "Is this a test call (replay mode)?"

The URL service cannot observe replay mode directly. In replay mode the
substrate short-circuits the HTTP call entirely, so your URL service
never receives the call. The gateway records the live-mode call once;
the response is what gets replayed. Don't side-effect on every call;
make your work idempotent on `requestId`.

## The X-Gateway-Mode header

| Value | Meaning |
|---|---|
| `live` | This is a real call; the URL service does its work |
| `replay` | The substrate is *recording* what your live response should be? No — the substrate never sends `replay` to a URL service. Replay is short-circuited at the gateway. Your URL service will only see `live`. The header is informational |

So URL services in practice only see `live`. The `replay` value is a
gateway-internal label that appears in `api.invoke.wire` history events.

## Observability inside a URL service

The substrate stamps `traceparent` and `X-Gateway-Trace-Id` on the
outbound HTTP. A URL service that emits OTel spans should:

- Extract `traceparent` and open spans as children.
- Use the trace context to propagate to any downstream calls (vendor
  SDKs, DB queries, etc.).
- Emit metrics under `pax_urlsvc_<kind>_*` namespace.
- Echo `X-Gateway-Request-Id` into response logs.

This makes a URL service's internals show up on the same distributed
trace as the bundle call.

A template lives at `examples/url-services/REFERENCE-OBSERVABILITY.md`
(planned companion doc to the operator-shipped URL service zoo).

## Error responses

URL services map their failures to HTTP status codes; the substrate
maps **all** non-2xx responses to `providerError` on the bundle side
with the URL service's body preserved in `detail`.

A URL service can therefore signal any error shape it wants. Conventions:

- `400` for malformed `args` or `context`.
- `403` for trust-rule violations (player not connected, spectator,
  rate-limited at the URL service's own layer).
- `429` for URL-service-specific rate limiting (not the substrate's
  `api-invocations-per-min` budget — that fails before the call
  reaches the URL service).
- `500` for internal errors.
- `503` for downstream (vendor) outages.

The bundle should treat all of these as `providerError` and decide
whether to retry, fall back, or fail.

## Idempotency

If the bundle supplied an `idempotencyKey` in `c.api.invoke`, it's in
`context.idempotencyKey`. The URL service can use it to dedupe:

```ts
if (await urlServiceDB.hasSeenIdempotencyKey(ctx.idempotencyKey)) {
  return res.status(200).json({ result: cachedResult });
}
// do the work, cache the result keyed by idempotencyKey
```

The substrate doesn't dedupe on this key; URL services do (or don't).

## URL service registration

To make a URL service callable, the vercel backend registers it:

```bash
POST /admin/api-kinds
Content-Type: application/json

{
  "kindName": "ai.chat.v1",
  "url": "https://vercel-backend.vercel.app/api/url-services/ai-chat-v1/invoke"
}
```

The substrate caches the registry at boot; cache invalidation happens
on `POST /admin/api-kinds`. Subsequent `c.api.invoke('ai.chat.v1',
args)` calls dispatch to the new URL.

To deprecate: `DELETE /admin/api-kinds/ai.chat.v1`. Subsequent calls
return `kindUnknown`. There is no grace period — when the registry row
goes away, calls fail.

For zero-downtime migration: register `ai.chat.v2`, update bundles to
call `v2`, leave `v1` in place until no bundle references it, then
unregister `v1`.

## Substrate-shipped reference URL services

The substrate ships four reference services co-deployed with the
gateway (see [`subsystems/api-gateway.md`](../subsystems/api-gateway.md)):

- `echo.v1` — Returns `args` verbatim. For SDK round-trip testing.
- `delay.v1` — Waits `args.delayMs` then returns a result. For latency
  scenarios.
- `http.fetch.v1` — Real outbound HTTP against an allowlist. For
  bundles that need to call arbitrary external URLs.
- `mock-ai.v1` — Canned ai-shaped responses keyed by `sha256(args)`.
  For scenarios that need ai-shaped output without an LLM bill.

These are URL services in every sense: registered in the kind registry,
called via the gateway, recordable, replayable. They just happen to be
in the substrate's repo.

## Cross-references

- [`reference/gateway-envelope.md`](../reference/gateway-envelope.md) — wire shape
- [`contract/external-api-channel.md`](../contract/external-api-channel.md) — bundle side
- [`subsystems/api-gateway.md`](../subsystems/api-gateway.md) — substrate-side dispatch
- [`billing-policy.md`](billing-policy.md) — billing-shaped URL services
- [`participation-and-roles.md`](participation-and-roles.md)
- [`moderation-policy.md`](moderation-policy.md)
- [`projection-sync.md`](projection-sync.md)
- [`reference/admin-api.md`](../reference/admin-api.md) — kind registration
