# Why: no `Role` / `RoleAssignment` substrate units

> Layer: **Why**

## Considered

An earlier proposal for substrate-owned role primitives:

- A `Role` unit per game (substrate-owned): `{ roleId, gameId, name,
  attributes }`.
- A `RoleAssignment` unit (substrate-owned): `{ roleId, playerId,
  assignedAt }`.
- Substrate channels for the bundle: `c.roles.create(name, attrs)`,
  `c.roles.destroy(roleId)`, `c.roles.list()`.
- Lifecycle hooks `onRoleAssigned({ playerId, roleId })` and
  `onRoleReleased`.
- Admin endpoint `POST /admin/games/:id/players/:playerId/role` so the
  vercel backend can assign roles.
- Envelope-side fields: `triggeringSessionRoleId`,
  `connectedSessions[*].roleId`.

The motivating use case was: Pax-historia has participants vs spectators,
and the vercel backend's billing system needs to know which player is
which. A substrate-owned role primitive could surface that information
cleanly in every `api.invoke` envelope.

## Why we said no

The substrate has zero domain knowledge about what a role *is* in any
particular operator's mental model. Adding role primitives forces the
substrate to commit to:

- **A namespace for role names.** Are they free-form strings? Enum?
  Operator-owned? Substrate-owned?
- **Cardinality rules.** Can a player have multiple roles in one game?
  Is "no role" a sentinel?
- **Assignment semantics.** Sync or async? Substrate-enforced uniqueness?
  Can a bundle reject an assignment? Can a player self-assign?
- **History grain.** Is role assignment a session-shaped event? A
  game-shaped event? A separate stream?
- **Lifecycle policy.** Do roles persist across sleep/wake? Do they reset?
  Does the bundle have a say?

Every one of these is **a billing-and-policy decision dressed up as a
substrate primitive.** Pax-historia's participant/spectator model is
specific to its game shape; a different operator's role model would be
totally different (factions, classes, ranks, ownership stakes).

Once the substrate has role primitives, it has to fight one of two ways:

- **Liberal.** Allow arbitrary role naming, free-form attributes, cross-game
  role transfer. Now the substrate has a billing-like vocabulary that's
  still under-determined, and the vercel backend has to layer policy on
  top anyway. The substrate gained complexity without simplifying
  operators' lives.
- **Conservative.** Pick one role model (e.g. enum of `participant |
  spectator | moderator`) and bake it in. Now the substrate has a
  Pax-historia-shaped concept hard-coded — exactly what the "no billing"
  rule was meant to prevent.

So we don't.

## The substitute: participation as a URL service

Participation lives in a URL service the vercel backend implements
(`participation.v1`). The substrate's `connectedSessions[]` snapshot and
`triggeringJwtClaims` give the URL service enough information to
answer queries about a session's role/participation status.

For changes to participation state, the substrate exposes the host-event
channel (`POST /admin/games/:id/host-event`). When the vercel backend
flips a player from participant to spectator, it:

1. Updates `participation.v1`'s state (the URL service's own database).
2. Sends a host event to the bundle (`{ eventType: 'participation.changed',
   payload: { playerId, newRole } }`).
3. The bundle's `onHostEvent` handler receives the change and updates its
   own view.

The trust property is preserved on the URL service side: a billing URL
service (`ai.chat.v1`) calls `participation.v1.get(playerId, gameId)`
before billing every player. If `participation.v1` says spectator, the
billing URL service refuses.

See [`operator-overlays/participation-and-roles.md`](../operator-overlays/participation-and-roles.md).

## The asymmetric write rule (for the overlay)

The vercel backend's policy is: bundles can **demote** a player to
spectator (game-logic authority) but cannot **promote** to participant
(billing authority stays out of bundle code). This is operator policy,
not substrate policy. The substrate's `participation.v1` URL service
implements the asymmetry on its server side; the substrate doesn't know
about it.

## What would change our mind

We'd reconsider if:

1. **Every URL service implementing billing/participation ends up needing
   the same role primitive** and we could distill it into an
   operator-namespace-opaque primitive (like compat tags). We don't see
   this — different operators have wildly different role models.
2. Substrate observability turns out to need to know about roles to
   produce useful history events. (It doesn't; roles change events are
   URL service events, not substrate events.)

Until then: no roles in the substrate. Participation is an overlay.

## See also

- [`why-no-billing.md`](why-no-billing.md) — sibling decision
- [`operator-overlays/participation-and-roles.md`](../operator-overlays/participation-and-roles.md)
  — the overlay pattern that replaces role units
- [`vision/non-goals.md`](../vision/non-goals.md)
