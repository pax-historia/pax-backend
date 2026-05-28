# RFC: substrate additions required for the historia-default proof

The historia-default proof (see
[`port-from-paxhistoria.md`](port-from-paxhistoria.md)) requires two small
substrate-contract additions. Neither introduces billing or game-shaped
vocabulary; both are generic primitives the substrate can specify in a
paragraph each.

Earlier design rounds proposed larger additions (`c.schedule.*` scheduled
wakeups with a persisted `ScheduledTimer` unit; `Role` / `RoleAssignment`
substrate-owned units with envelope-side `triggeringSessionRoleId` and
`onRoleAssigned` / `onRoleReleased` hooks); both were **rejected** in favor
of leaner mechanisms. See §3 for the trade-offs the rejections lock in.

This RFC is intentionally narrow. Anything outside the two additions below
is explicitly out of scope.

## 1. Sleep grace period (trivial)

### Why

The substrate already hibernates idle games (per
[pax-sharded-spike](../../../pax-sharded-spike/)) and wakes them on player
reconnect. The proof needs the game to stay warm for a short window after
the last disconnect so that flaky-connection reconnects and quick
tab-reopens don't pay the cold-start cost.

### Surface

| Element | Shape |
|---|---|
| Substrate constant | `SLEEP_GRACE_MS = 60_000` (1 minute) |
| Per-bundle override | None in v1 |
| Behavior on last disconnect | Start a 60s timer; if no new connect arrives, fire the existing `onSleep` hook and hibernate |

Fixed across all bundles. Revisitable if usage data demands.

### Substrate work

Trivial: one constant + a 60s timer in the existing sleep-policy code
path. No manifest field, no per-bundle override, no ceiling-enforcement
logic.

### Guarantees

No new strong platform guarantee required — this is a tightening of the
existing sleep-policy behavior, observable via the existing
`session.opened` / `session.closed` / `lifecycle.sleepComplete` history
events. The scenario-runner can assert the timing trivially.

## 2. Host event channel (with wake-on-delivery)

### Why

The substrate currently has no way for an operator-owned URL service (or
the host's own backend) to push an out-of-band event into a running game
session. The proof needs this for two distinct flows:

- **Participation-change notifications** — the
  [`participation.v1`](../../examples/url-services/participation.v1/README.md)
  URL service needs to tell the bundle when a player flips to spectator
  (either by player choice via the host's "Spectate" button, or by the
  bundle's own write). Best-effort while-awake is fine here — if the game
  is asleep, the bundle re-fetches fresh state from `participation.v1` on
  next wake.
- **Moderation eject events** — when a user gets banned globally, the host
  has to be able to fire "eject this player from this game" to every game
  the user is in — **including games that are currently asleep and may
  not have been played for weeks.** This requires the substrate to wake
  the game just to deliver the event.

So the channel needs two delivery modes.

### Surface

| Element | Shape |
|---|---|
| Admin endpoint | `POST /admin/games/:id/host-event` body `{ eventType: string, payload: unknown, wakeOnDelivery?: boolean }`; returns 202 |
| Bundle lifecycle hook | `onHostEvent({ eventType, payload, receivedAt })`; bundle dispatches based on `eventType` (substrate has no opinion) |
| Default delivery (`wakeOnDelivery: false`) | Best-effort while-awake. Dropped if game is asleep |
| Durable delivery (`wakeOnDelivery: true`) | Substrate persists; wakes the game if asleep via existing cold-start path; delivers; game returns to sleep naturally after grace period |
| Auth | Substrate admin token (same as other `/admin/*` endpoints) |
| Ordering | FIFO per game |
| TTL on queued `wakeOnDelivery` events | 30 days; older events dropped with a logged warning |

URL services that need to fire host events get the admin token configured
at deploy time.

### Substrate work

| Component | Work |
|---|---|
| Admin route | New |
| IPC message kind (parent → child) | New |
| Bundle-side handler dispatch | New, but dispatched on `eventType` so opinion-free |
| Durable event queue per game | New (Redis-shaped; can share the active-game-directory Upstash instance) |
| Event-processor component | Small; on enqueue of a `wakeOnDelivery: true` event, triggers a placement request through the same path WS-driven wakes use |

### New strong platform guarantee

> **Guarantee #17 (host-event durability)** — A `wakeOnDelivery: true`
> host event is delivered at least once to the bundle's `onHostEvent`
> handler within TTL of the host's POST, including across game
> hibernation. Bundle code MUST be idempotent on `eventType + payload`
> equality (or include its own dedup key inside `payload`).

### New scenario-runner oracle

One new oracle in `testing/oracles-lib/src/guarantees/` named
`host-event-durability.mts` that asserts: for every
`POST /admin/games/:id/host-event` with `wakeOnDelivery: true` recorded in
the scenario run's history, there is a corresponding
`onHostEvent.delivered` history event for the same `(gameId, eventType,
payload)` within TTL.

### Relationship to scheduled wakeups (rejected; see §3)

The `wakeOnDelivery` machinery is most of the infrastructure that would
have been needed for `c.schedule.*` — a durable queue + a wake mechanism.
If scheduled wakeups ever come back to the substrate scope in v2+, they
can be built on top of this same machinery — but the trigger remains
host-driven (URL service or admin call), never bundle-driven. That
preserves the §3 rule that the bundle cannot request its own wake.

## 3. Rejected proposals (recorded for posterity)

### 3.1 Scheduled wakeups (`c.schedule.*` + `onTimer` + `ScheduledTimer` unit)

**Earlier proposal:** `c.schedule.in(ms, payload)` / `c.schedule.cancel(id)`
bundle channels; `onTimer({ scheduleId, payload, scheduledAt, firedAt })`
lifecycle hook; `ScheduledTimer` substrate-owned unit in a durable timer
ledger; scheduler component in the control plane.

**Rejected.** The new rule is *games are alive iff someone is connected
(plus the §1 grace period and substrate-initiated migration warning)*.

**Bundle pattern for short-duration timers** (anything that should fire
while someone is connected): in-isolate `setTimeout`. Re-armed on wake if
needed. Lost when game sleeps, which is fine because by definition no one
is observing.

**Bundle pattern for long-duration deadlines** (anything that needs to
survive across sleep/wake): *mark the `fireAt` timestamp in `c.state`
(or in a `c.blob` key for very large deadline sets), then check whether
the threshold was crossed on `onWake` and on every player message.* No
JS timer is involved; the bundle's "is it past time T?" check fires
naturally next time the game is awake. Under the storage-tiers-v2
contract (see [README.md](../../README.md) §"Storage tiers"), `c.state`
writes are durable to Tigris within the flush window (default 1 s) and
are flushed before sleep on planned transitions — so the timestamp
survives whatever caused the game to go idle. If the bundle needs the
write durable before `onSleep` returns, it calls `c.state.flush()`.
Same pattern paxhistoria already uses for round timers.

**Trade-off accepted:** no async-game auto-progression while everyone is
offline. The deadline check fires on the next reconnect or
substrate-initiated wake. If a strict-deadline workflow ever needs
server-driven wakes, the host runs a cron job that force-advances or
force-ends stale games via substrate admin endpoints — not a substrate
concern.

### 3.2 Role registry + assignment substrate units

**Earlier proposal:** substrate-owned `Role` and `RoleAssignment` units;
`c.roles.create/destroy/list` bundle channels; `onRoleAssigned` /
`onRoleReleased` lifecycle hooks; envelope-side
`triggeringSessionRoleId` and `connectedSessions[*].roleId`; admin
endpoint `POST /admin/games/:id/players/:playerId/role` for assignment.

**Rejected.** Substrate stays participation-agnostic. Participant state
lives in the
[`participation.v1`](../../examples/url-services/participation.v1/README.md)
URL service. The host-event channel (§2) handles bundle notification of
changes.

**Trade-off accepted:** every `ai.chat.v1` call does a fresh HTTP hop to
`participation.v1` (no caching), in parallel with the AI service's
existing token-ledger / resource-ledger reads — the round-trip lands
inside the existing latency envelope. The trust property is preserved by
`participation.v1`'s server-side rule that `setParticipant` requires the
host auth token, not the bundle's call.

## Out of scope for this RFC

- **Per-bundle sleep-grace overrides.** Only the substrate constant in §1.
- **Bundle-initiated wakeups.** §2 is host-only; bundles cannot request
  their own wake.
- **In-band history events for participation changes.** The substrate
  emits no `participation.*` history events; the URL service owns
  participation history. Substrate sees host-event POSTs as opaque (just
  the `eventType` string + payload routing).
- **Anything else** — auth changes, blob layout changes, new compute
  budgets, additional lifecycle hooks. Out.
