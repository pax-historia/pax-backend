# Why: no async games (server-driven progression while nobody is connected)

> Layer: **Why**

## Considered

A substrate where games progress on their own when no one is connected.
Concretely: a substrate-managed scheduler that wakes a game at a future
timestamp to advance state (a turn ticks, a round resolves, a notification
fires).

This is a real ask in some genres — long-duration strategy, idle clickers,
correspondence chess. Pax-historia's earlier design had jump-forward
deadlines that ostensibly needed server-side progression.

## Why we said no

The rule is: **games are alive iff someone is connected** (plus a
short sleep-grace window and substrate-initiated wake-on-delivery for
host events). When no player is connected, the bundle is asleep. No
timers fire. No state mutates.

Two reasons:

1. **Cost discipline.** Every server-driven wake is shard CPU + a Tigris
   load. With 1k concurrent games and async wake patterns, those costs
   compound; the substrate would need an opinion about scheduling pressure,
   timer batching, and whose timer goes first. None of that is value-add
   for the gameplay we ship.

2. **Observability discipline.** When a game is asleep and the substrate is
   simulating something on its behalf, no human is watching to validate.
   "The game advanced 5 rounds while you were offline because of timer
   logic in the bundle" is a debugging nightmare relative to "the game
   advanced 5 rounds the next time you reconnected." The latter is
   inspectable in `onWake`; the former requires history-archaeology on
   events nobody requested.

Pax-historia confirms (per the user's clarification) that **async games
are out**. The bundle pattern for long-duration deadlines is:

> Stamp the `fireAt` timestamp into `c.state` when the deadline is set.
> Check whether `Date.now() >= fireAt` on every `onWake` and on every
> player handler. If the threshold has been crossed, do the work.

This works because:
- `c.state` is Tigris-canonical with flush-window durability, so the
  timestamp survives any sleep/wake.
- The check is free (one comparison per handler tick).
- The deadline fires the next time **a player reconnects** or **a
  host-driven wake delivers a host event**.

If the vercel backend ever needs deadlines that fire even with no player
reconnect, it runs its own cron that calls admin endpoints (`POST
/admin/games/:id/host-event` with `wakeOnDelivery: true`) to advance or
force-end stale games. The substrate honors host-event delivery as a
guarantee (#17), so the substrate-side is solved. But the substrate does
not own the timer logic.

## What would change our mind

The substrate adds async-game support if and only if:

1. The vercel backend cron-via-admin pattern proves operationally
   unworkable at the relevant cadences. (We don't expect this; cron
   intervals are typically minutes-to-hours, which the admin REST surface
   handles trivially.)
2. A genre Pax-historia commits to ship requires sub-cron resolution
   timers (e.g. seconds-granularity off-line ticks) and the cron path
   is too coarse. (Out of expected scope.)

Until then: the substrate is connection-driven. Wakes come from player
reconnect, host event, or planned migration. They do not come from a
timer the substrate or the bundle owns.

## Knock-on consequences

This decision propagates:

- **No `c.schedule.*` substrate channel.** See
  [`why-no-scheduled-wakeups.md`](why-no-scheduled-wakeups.md).
- **No `onTimer` lifecycle hook.** Six hooks only.
- **No `ScheduledTimer` substrate unit.** No persisted timer ledger.
- **`onCapacityWarning` is push-based**, fired in the moment, not a
  scheduled review.

## See also

- [`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md) —
  the full wake reason list
- [`why-no-scheduled-wakeups.md`](why-no-scheduled-wakeups.md) — the
  related-but-distinct decision
- [`vision/non-goals.md`](../vision/non-goals.md)
