# Billing policy as an overlay

> Layer: **Operator overlay**

Billing is **not a substrate primitive**. The substrate has no `Balance`,
no `Reservation`, no `DebitLogEntry`, no `Refund` — see
[`why/why-no-billing.md`](../why/why-no-billing.md). What the substrate
*does* provide is the session observability that lets billing-shaped
URL services make trust-aware decisions without storing any
billing state in the substrate.

This page documents the pattern Pax-historia uses to implement billing
on top of session observability. It is a worked example, not a contract.

## The shape of an operator-owned billing URL service

A typical billing-shaped kind (Pax-historia's `ai.chat.v1` is the
canonical example):

```
Bundle -- c.api.invoke('ai.chat.v1', args) --> Substrate (gateway)
                                                      |
                                  HTTP POST envelope  v
                                                Vercel backend
                                                'ai.chat.v1' URL service
                                                  |
                            ┌─────────────────────┼───────────────────────┐
                            v                     v                       v
                  Read connectedSessions   Check participation     Call the AI vendor
                  from context envelope    via participation.v1    (Anthropic / OpenAI)
                            |                     |                       |
                            └─────────────────────┴───────────────────────┘
                                                  |
                                Compute cost; debit token ledger
                                Return { result: ... }
```

Inside the URL service, all the business logic lives: which players to
bill, how much, refund rules, token-cap enforcement, fraud heuristics,
vendor billing reconciliation. The substrate is **uninvolved**.

## What the substrate provides (the foundation)

Every `c.api.invoke` HTTP call to a billing URL service includes:

| Field | Why a billing URL service cares |
|---|---|
| `connectedSessions[]` | "Only bill players who are connected" — the URL service refuses to bill if `args.billToPlayer` isn't in the snapshot |
| `triggeringSessionId` | Distinguishes "this call came from a player's WS message" vs "this call came from `onWake` / `onCapacityWarning` / `onHostEvent`" — useful for billing different categories of activity |
| `triggeringJwtClaims` | Verbatim claims from the router-signed WS JWT, including the `passthrough` block the vercel backend supplied at placement time (Firebase identity, role hints, vercel-backend-issued trust tokens) |
| `bundleName`, `bundleCompatTag` | Lets the URL service apply per-bundle pricing or refuse calls from unexpected bundles |
| `gameId` | Identifies the game; the URL service uses this as a billing scope (e.g. per-game spend caps) |

These five fields plus the URL service's own ledger are sufficient to
implement every billing pattern Pax-historia has needed.

## Pattern 1: "Only bill connected players"

```ts
app.post('/invoke', async (req, res) => {
  const { args, context } = req.body;
  const { billToPlayer } = args;

  // The bundle is asking us to bill billToPlayer.
  // The substrate told us exactly who's connected.
  const isConnected = context.connectedSessions.some(s => s.playerId === billToPlayer);
  if (!isConnected) {
    return res.status(403).json({ error: 'playerNotConnected' });
  }

  // Now we can bill safely.
  await debit(billToPlayer, computeCost(args));
  const result = await callVendor(args);
  return res.status(200).json({ result });
});
```

A compromised bundle that tries to bill arbitrary players for AI calls
hits this guard. The substrate isn't involved in the decision; it just
honestly reports who was connected.

## Pattern 2: "Spectator caps via participation lookup"

The bundle has no concept of "spectator," but the vercel backend's
`participation.v1` URL service does. The billing URL service consults
it before billing:

```ts
const role = await fetch(`http://internal/participation.v1/get`, {
  body: JSON.stringify({ playerId: billToPlayer, gameId: context.gameId }),
}).then(r => r.json());

if (role.kind === 'spectator') {
  return res.status(403).json({ error: 'playerIsSpectator' });
}

await debit(billToPlayer, computeCost(args));
```

See [`participation-and-roles.md`](participation-and-roles.md) for the
participation overlay.

## Pattern 3: "Per-session spend cap"

The URL service keys its ledger on `(gameId, sessionId)` instead of
`(gameId, playerId)`. The substrate's stable `sessionId` makes this
trustworthy:

```ts
const sessionSpend = await ledger.getSessionSpend(context.gameId, context.triggeringSessionId);
if (sessionSpend + computeCost(args) > sessionCap) {
  return res.status(429).json({ error: 'sessionCapExceeded' });
}

await ledger.debitSession(context.gameId, context.triggeringSessionId, computeCost(args));
```

A compromised bundle can't forge a different `sessionId` because the
substrate stamps it from its own state at dispatch time (guarantee #3).

## Pattern 4: "Refund on substrate error"

If the substrate returns `providerError`, the bundle knows the call
failed. If the bundle wants to refund, it issues a separate
`c.api.invoke('ai.refund.v1', { idempotencyKey: originalKey })`. The
refund URL service:

```ts
const original = await ledger.getCall(args.idempotencyKey);
if (!original) {
  return res.status(404).json({ error: 'callNotFound' });
}
if (original.refunded) {
  return res.status(200).json({ result: { refunded: false, reason: 'alreadyRefunded' } });
}
await ledger.refund(original);
return res.status(200).json({ result: { refunded: true, amount: original.cost } });
```

The substrate doesn't know any of this is happening. It dispatches
`ai.chat.v1`, records the wire bytes, dispatches `ai.refund.v1`,
records those wire bytes too. Reconciliation is entirely the URL
services' problem.

## Pattern 5: "Per-game spend cap (game-pool style)"

The URL service keys its ledger on `gameId` and refuses calls when the
per-game cap is exhausted:

```ts
const gameSpend = await ledger.getGameSpend(context.gameId);
if (gameSpend + computeCost(args) > gamePool) {
  return res.status(429).json({ error: 'gamePoolExhausted' });
}
```

This is the "spectator games can't outrun their budget" pattern. The
bundle gets `providerError`; it can choose to wind down gracefully or
disconnect players with a "game over" message.

## What the substrate's compute-plane budget *isn't*

The substrate's `api-invocations-per-min` budget (a compute-plane
budget) prevents a bundle from DOSing the gateway and downstream URL
services. **It is not a billing concept.** A bundle that calls 100×/min
when its game has no business logic is wasting compute capacity, not
spending tokens.

URL-service-side rate limiting (429s from the URL service) is a separate
mechanism. A bundle can hit either or both.

## Anti-patterns

### Storing billing state in the substrate

Not possible. The substrate has no admin endpoint for it, no Postgres,
no key in the IPC envelope.

### Encoding billing into substrate channel names

Don't. The substrate's channel set is the contract. Billing wraps live
inside `args`.

### Trusting the bundle's claim of "who to bill"

Always cross-check against `context.connectedSessions`. The bundle is
untrusted by definition.

### Doing billing inside the bundle

Possible but a footgun. A compromised bundle can lie about anything it
sees. Keep billing decisions in the URL service.

## The Pax-historia billing service shape (for reference)

Pax-historia's `ai.chat.v1` URL service is the canonical billing-shaped
URL service in production. Its responsibilities, ordered:

1. Parse `args` (messages, billToPlayer, model hints, max tokens).
2. Parse `context` (gameId, connectedSessions, triggeringSessionId,
   triggeringJwtClaims).
3. Check `connectedSessions.some(s => s.playerId === billToPlayer)` —
   refuse `playerNotConnected` if not.
4. Call `participation.v1.get(billToPlayer, gameId)` — refuse
   `playerIsSpectator` if spectator.
5. Read `token_ledger` for the player — refuse `insufficientTokens`
   if balance < estimate.
6. Reserve tokens (two-phase against the ledger inside the URL service).
7. Call the vendor (Anthropic / OpenAI / Alibaba).
8. Compute actual token usage.
9. Commit the reservation (subtract from balance, log to debit ledger).
10. Return `{ result: { messages: [...] } }`.

Steps 6 and 9 are URL-service-internal — the substrate never sees them.
The whole flow is in the URL service's own database and code, with the
substrate observing only the wire-grain envelope and response.

## Cross-references

- [`why/why-no-billing.md`](../why/why-no-billing.md)
- [`url-service-authoring.md`](url-service-authoring.md)
- [`participation-and-roles.md`](participation-and-roles.md)
- [`contract/external-api-channel.md`](../contract/external-api-channel.md)
- [`reference/gateway-envelope.md`](../reference/gateway-envelope.md)
- [`proofs/historia-default.md`](../proofs/historia-default.md)
