# Moderation policy as an overlay

> Layer: **Operator overlay**

The substrate has no moderation pipeline, no content classifier, no
ban list. It does provide three primitives that make any moderation
policy implementable:

1. **`removeAllowedPlayer`** — substrate-enforced; force-disconnects.
2. **`DELETE /admin/players/:playerId`** — a single substrate operation
   that iterates every game the player is allowed in and runs
   `removeAllowedPlayer` on each. The caller sees one 202 response;
   the substrate emits one `player.deleted` history event after all the
   per-game removals fan out (push-with-202; see
   [`subsystems/control-plane-admin-api.md`](../subsystems/control-plane-admin-api.md)).
3. **Host events** — wake-on-delivery for moderation-triggered events
   that the bundle should know about (e.g. "this player was just banned;
   eject them from this game").

This page documents Pax-historia's moderation pattern as a worked
example.

## The three moderation roles

Pax-historia has three flavors of moderation, each composing
substrate primitives differently:

| Flavor | Source | Composition |
|---|---|---|
| **Bundle-detected content moderation** | The bundle's own workflow logic (e.g. AI flags a message as TOS-violating) | Bundle calls a moderation URL service (`moderation.audit.v1`); URL service decides; if severe, vercel backend issues `DELETE /admin/players/:playerId` |
| **Vercel-backend-initiated bans** | Human moderator clicks "ban this user" | Vercel backend issues `DELETE /admin/players/:playerId`; substrate handles cross-game force-disconnect; substrate emits host events to running games so they can update displays |
| **Vendor-side flags** | LLM provider returns a moderation flag | URL service inside `ai.chat.v1` decides whether to surface to the bundle as a typed response or escalate |

## The `moderation.audit.v1` URL service shape

A typical moderation URL service:

```
POST /moderation.audit.v1/invoke
{
  args: {
    op: 'recordVerdict' | 'recordBan',
    playerId: string,
    gameId: string,
    content?: string,
    classifierLabel?: string,
    severity?: 'low' | 'medium' | 'high',
  }
}
→ 200 { result: { action: 'none' | 'warn' | 'mute' | 'ban', auditId: string } }
```

The URL service:

1. Persists the verdict to its own audit DB.
2. Decides the action based on prior verdicts (warn after first violation,
   mute after second, ban after third).
3. If `action === 'ban'`, issues `DELETE /admin/players/:playerId` to
   the substrate.
4. Returns the action to the bundle.

## The force-disconnect flow

When the moderation URL service decides to ban, it calls the substrate's
admin REST:

```
DELETE /admin/players/<playerId>
```

The substrate:

1. Lists every game where the player is allowed (`Redis lookup`).
2. For each game, removes the player from `allowedPlayers`.
3. Notifies each game's parent actor to force-disconnect any live
   sessions for this player on this game.
4. Emits `player.deleted` to history; `session.forceDisconnect` for
   each affected session.
5. Returns 202 Accepted.

For games whose players are connected, the substrate proactively
disconnects them; the bundle sees `onPlayerDisconnect` with
`reason: 'removedFromAllowedPlayers'`.

For games that are **asleep**, no per-game action is needed at the
substrate layer — the player is just no longer in the allowed-players
list, and any future reconnect attempt will fail.

## The wake-on-delivery host event

If the moderation flow wants to **notify a sleeping game** that one of
its players was just banned (e.g. so the bundle can update a display,
emit a leaderboard event, or call a downstream service), it fires a
host event with `wakeOnDelivery: true`:

```
POST /admin/games/<gameId>/host-event
{
  eventType: 'moderation.ejected',
  payload: { playerId, reason: 'tos-violation' },
  wakeOnDelivery: true
}
```

The substrate:

1. Persists the event in the per-game durable queue.
2. If the game is asleep, triggers a placement; wakes the game.
3. Delivers via `onHostEvent`.
4. The game returns to sleep naturally after the grace window.

This is the use case that motivated the `wakeOnDelivery: true` flag
(see [`why/why-no-async-games.md`](../why/why-no-async-games.md) and
[`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md)).
Guarantee #17 commits the substrate to at-least-once delivery within
the 30-day TTL.

## What the substrate does NOT enforce

- Content classification. The substrate has no opinion on what's
  TOS-violating.
- Ban policy. Three-strikes vs immediate-ban is a URL service / vercel
  backend decision.
- Audit log retention. The moderation URL service holds the audit
  ledger; the substrate's history records that calls happened but not
  their semantic interpretation.
- Appeal flows. Out of scope.
- Cross-game ban inheritance. The substrate atomically removes from
  every game's allowed-players list, but "should this user be banned
  *next* time they create a new account" is identity-layer, not
  substrate.

## What the substrate DOES enforce

- **No bypass.** A player removed from `allowedPlayers` cannot reconnect
  to that game with a valid JWT (guarantee #2). Force-disconnect is
  proactive on the games they're currently in.
- **Atomicity** of `DELETE /admin/players/:playerId` across all the
  player's games.
- **History records** every `session.forceDisconnect` so post-hoc
  audits can reconstruct who was kicked when.

## Bundle-side moderation

A bundle can also do its own moderation without involving a URL service
— e.g. content filtering on `onPlayerMessage` based on regex. The
substrate provides `ws.send` for telling players "your message was
filtered" and `lifecycle.requestSleep` for ending a game early.

Bundle-side moderation is fast and local but trust-vulnerable: a
compromised bundle would simply not enforce the filter. For
trust-bearing moderation (anything that affects billing, ranking, or
durable state), use a URL service.

## Reference: the four canonical moderation flows

| Flow | Substrate involvement |
|---|---|
| Bundle filters content locally (`onPlayerMessage` regex check) | None |
| Bundle calls `moderation.audit.v1` to record a verdict | Dispatches the call; records wire bytes |
| Moderation URL service issues `DELETE /admin/players/:id` | Cross-game disconnect + history events |
| Vercel backend issues `host-event` to notify games of a ban | Durable delivery (guarantee #17) |

## Cross-references

- [`subsystems/control-plane-admin-api.md`](../subsystems/control-plane-admin-api.md)
  — `DELETE /admin/players/:id` and host events
- [`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md)
  — `onHostEvent`, disconnect reasons
- [`vision/guarantees.md`](../vision/guarantees.md) #2 (allowed-only),
  #17 (host event)
- [`url-service-authoring.md`](url-service-authoring.md)
- [`why/why-no-billing.md`](../why/why-no-billing.md) — moderation is
  sibling overlay
