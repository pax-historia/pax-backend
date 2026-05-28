# Participation and roles as an overlay

> Layer: **Operator overlay**

The substrate has **no role concept**, no participant/spectator
distinction, no role registry. See
[`why/why-no-role-units.md`](../why/why-no-role-units.md). Operators
that need role semantics layer them on top via a URL service.

This page documents the pattern Pax-historia uses (the `participation.v1`
URL service). It is a worked example, not a substrate contract.

## The participation URL service

Operators define a participation URL service with the operations they
need. Pax-historia's `participation.v1`:

```
POST /participation.v1/invoke
{
  args: { op: 'get', playerId, gameId }
}
→ 200 { result: { kind: 'participant' | 'spectator' | 'unknown', assignedAt?: '...' } }

POST /participation.v1/invoke
{
  args: { op: 'setSpectator', playerId, gameId, requesterAuth: '...' }
}
→ 200 { result: { kind: 'spectator', assignedAt: '...' } }
→ 403 { error: 'authRequired' }

POST /participation.v1/invoke
{
  args: { op: 'setParticipant', playerId, gameId, requesterAuth: '...' }
}
→ 200 { result: { kind: 'participant' } }
→ 403 { error: 'hostOnly' } (when requesterAuth doesn't carry the vercel-backend host token)
```

The URL service maintains its own database keyed by `(playerId,
gameId)`. The substrate doesn't know any of this exists beyond
"this is a registered kind that gets HTTP traffic."

## The asymmetric write rule

Critical pattern: **bundles can demote but cannot promote**.

| Operation | Who can call |
|---|---|
| `setSpectator` (demote) | Bundle (creator code) — kills an in-progress claim, dissolves a coop, demotes a bad actor |
| `setSpectator` (player choice) | Vercel backend on behalf of the player ("Spectate" button) |
| `setParticipant` (promote) | Vercel backend with host auth token only — **bundles cannot promote** |
| `get` | Anyone (bundle, billing URL service, vercel backend) |

The asymmetry is enforced **server-side in `participation.v1`**. The
substrate doesn't enforce it; the URL service does. A bundle attempting
`setParticipant` hits a 403 because it doesn't carry the host auth
token.

This is the defense against "compromised bundle bills non-participants
by promoting them to participant" — the bundle can't promote, so it
can't manufacture targets to bill.

## How the bundle learns about participation changes

When the vercel backend (or a player via the "Spectate" button) demotes
a player to spectator, the bundle has to know so it can update its
display. The substrate provides the wire for this: host events with
`wakeOnDelivery: true`.

```
1. Player clicks "Spectate" in the vercel frontend.
2. Vercel backend updates participation.v1's DB:
   POST /participation.v1/invoke { args: { op: 'setSpectator', playerId, gameId } }
3. Vercel backend fires a host event to the substrate:
   POST /admin/games/:id/host-event
   { eventType: 'participation.changed', payload: { playerId, newRole: 'spectator' } }
4. Substrate routes the event:
   - If game is awake: deliver to bundle via onHostEvent (best-effort).
   - If game is asleep: persist in durable queue; wake game; deliver; back to sleep.
5. Bundle receives:
   onHostEvent({ eventType: 'participation.changed', payload: { playerId, newRole: 'spectator' }, ... })
6. Bundle updates its display, broadcasts via c.ws.send, etc.
```

For the case where a player flips to spectator while the game is asleep
and won't be reconnecting for weeks, `wakeOnDelivery: true` ensures
delivery. Guarantee #17 commits the substrate to at-least-once.

## How the billing URL service uses participation

A billing-shaped URL service (`ai.chat.v1`) consults `participation.v1`
on every billable call:

```ts
// Inside ai.chat.v1's URL service handler
const participation = await fetch('http://internal/participation.v1/invoke', {
  method: 'POST',
  body: JSON.stringify({ args: { op: 'get', playerId, gameId } }),
}).then(r => r.json());

if (participation.result.kind === 'spectator') {
  return res.status(403).json({ error: 'playerIsSpectator' });
}
```

No caching. The participation read happens on every billable call, in
parallel with the URL service's existing ledger reads. The round-trip
lands inside the existing latency envelope; the cost discipline is "do
it every time" rather than "cache and risk staleness."

This is the final defense if a compromised bundle ignores the
substrate's session observability: even if the bundle lies about who's
connected, the billing URL service consults `participation.v1` and
refuses.

## Why this isn't a substrate primitive

A `Role` substrate unit was considered and rejected (see
[`why/why-no-role-units.md`](../why/why-no-role-units.md)). The shape
above lives at the URL service layer because:

- Pax-historia's "participant vs spectator" model is operator-specific.
- A different operator could have completely different role shapes
  (factions, classes, ranks, ownership stakes).
- The trust property is the same: the URL service writes are gated by
  the URL service's own auth (host token), and the bundle has to consult
  the URL service rather than store role state itself.

The substrate provides the wires (session observability + host events);
the URL service provides the model.

## Pre-publishing options to the player

A common pattern: the bundle wants to tell a player "you can play as
character X, Y, or Z" so the vercel frontend can show a picker. The
substrate doesn't need to know about characters.

The bundle pre-publishes the option list via `c.ws.send` on connect:

```ts
async onPlayerConnect(c, { playerId, sessionId }) {
  const options = computeOptionsForPlayer(playerId);
  await c.ws.send(playerId, {
    type: 'role.options',
    options: [{ characterId: 'alice' }, { characterId: 'bob' }],
  });
}
```

The vercel frontend renders the picker. When the player picks, the
vercel backend (with host auth) calls
`participation.v1.setParticipant({ playerId, gameId, characterId })`.
The bundle gets notified via `onHostEvent`.

## Bundle-side participation cache

A bundle that needs to know participation state mid-game can:

1. Read it once on `onWake` (via `c.api.invoke('participation.v1', {
   op: 'get', playerId, gameId })` for each player).
2. Update it on every `onHostEvent({ eventType: 'participation.changed' })`.

The bundle's in-process cache is best-effort. The authoritative source
is `participation.v1`'s database. If the bundle's cache disagrees with
the URL service, the URL service wins (billing-side consultation is the
trust property; bundle-side cache is for UX).

## Cross-references

- [`why/why-no-role-units.md`](../why/why-no-role-units.md)
- [`billing-policy.md`](billing-policy.md) — how billing services use participation
- [`url-service-authoring.md`](url-service-authoring.md) — host auth patterns
- [`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md) — `onHostEvent`
- [`subsystems/control-plane-admin-api.md`](../subsystems/control-plane-admin-api.md) — host event POST
- [`vision/guarantees.md`](../vision/guarantees.md) #17
