# Why: no bundle-driven scheduled wakeups

> Layer: **Why**

## Considered

A bundle-facing API for self-scheduled future wakes:

- `c.schedule.in(ms, payload) → scheduleId`
- `c.schedule.at(timestamp, payload) → scheduleId`
- `c.schedule.cancel(scheduleId)`
- A new `onTimer({ scheduleId, payload, scheduledAt, firedAt })` lifecycle
  hook
- A `ScheduledTimer` substrate-owned unit, persisted in a durable timer
  ledger
- A scheduler component in the control plane that fires timers at the
  configured wallclock time and triggers a placement through the same path
  WS-driven wakes use

The motivating use case was: a bundle wants to "wake itself" some time in
the future to do work — fire a deadline, send a notification, advance a
round.

## Why we said no

This decision follows directly from
[`why-no-async-games.md`](why-no-async-games.md). If games are alive iff
someone is connected, then **bundle-driven scheduled wakeups have no
function**:

- For deadlines that fire **while a player is connected**: in-isolate
  `setTimeout` works. It's lost on sleep, which is fine because by
  definition no one is connected to observe the loss.
- For deadlines that fire **while no one is connected**: that's exactly
  the async-game case, and we said no to that.
- For deadlines the **vercel backend** wants to enforce regardless of
  connection state: that's the host-event channel with `wakeOnDelivery:
  true`, which is host-driven, not bundle-driven.

The host-driven case is real (moderation eject events, vercel-backend
cron jobs). It's covered by guarantee #17 and the
`POST /admin/games/:id/host-event` admin endpoint. So we ship the
mechanism for that — durable per-game event queue + wake-on-delivery —
without exposing it to bundles.

The crucial principle: **the bundle cannot request its own wake**. The
substrate wakes a game only when:

1. A player reconnects.
2. The vercel backend issues a `host-event` with `wakeOnDelivery: true`.
3. Planned cross-shard migration.

That keeps "alive iff connected" honest, keeps the wake path debuggable,
and avoids a substrate-side scheduler.

## The pattern bundles use instead

Mark-timestamp, check-on-wake:

```ts
// when setting a future deadline
await c.state.write({
  ...currentState,
  pendingDeadlines: [
    ...currentState.pendingDeadlines,
    { id: 'round-3-end', fireAt: c.now() + 5 * 60 * 1000 }
  ]
});

// on every onWake and every onPlayerMessage
const now = c.now();
const fired = state.pendingDeadlines.filter(d => d.fireAt <= now);
for (const d of fired) {
  // run the deadline's effect
}
```

This is what Pax-historia's round timers already do. It's idempotent (the
check runs every tick), durable (`c.state` is checkpoint-committed to
Tigris), and self-recovering (deadlines that fire while nobody is
connected just resolve on the next reconnect).

## What would change our mind

The substrate adds bundle-driven scheduled wakeups if and only if:

1. We change the async-games decision. (Tied to the substrate's
   "connection-driven" identity; unlikely.)
2. A genre Pax-historia commits to ship has a hard requirement that the
   `mark-timestamp, check-on-wake` pattern can't satisfy. We haven't
   identified one.

Cost note: the `wakeOnDelivery: true` machinery (durable per-game event
queue + wake mechanism) is most of the infrastructure that would be needed
for scheduled wakeups. So if we ever do reverse this decision, the
incremental implementation cost is small. But the **contract change** —
adding a lifecycle hook, exposing a scheduling primitive to bundles — is
the load-bearing cost, not the implementation. That's the cost we're
deferring.

## See also

- [`why-no-async-games.md`](why-no-async-games.md) — the parent decision
- [`subsystems/placement-and-wake.md`](../subsystems/placement-and-wake.md)
  — what the substrate does on host-event-driven wake
- [`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md) —
  the seven lifecycle hooks
- [`reference/admin-api.md`](../reference/admin-api.md) — the host-event
  POST endpoint
