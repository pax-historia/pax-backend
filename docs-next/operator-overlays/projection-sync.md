# Projection sync as an overlay

> Layer: **Operator overlay**

The vercel backend often needs a Postgres (or other DB) projection of
substrate state for queries the substrate's admin API doesn't directly
support: marketplace queries, game-by-creator lookups, leaderboards,
status pages, billing reconciliation.

The substrate's admin API + history stream is the source of truth. The
projection is a derived view the vercel backend builds and maintains.
This page documents the patterns.

## The four trust categories of substrate data

Every fact about a game falls into one of four buckets:

| Category | Trusted source | Mechanism | Examples |
|---|---|---|---|
| **Substrate-derivable** | Substrate | Vercel backend tails `GET /admin/history`, queries `GET /admin/games/:id/sessions` | Player session times, allowed-player changes, bundle flips, game-create/destroy events |
| **URL-service-derivable** | URL service's own ledger | Vercel backend queries the URL service's DB directly | Money spent per player per game, AI call counts, moderation verdicts |
| **Bundle-only-knowable** | Bundle | Bundle issues explicit `c.api.invoke('projection.sync.v1', { op, ...})` calls | Game `status` (in-progress / ended), display `currentRound`, "your turn" badges, title overrides, round-completed events |
| **Vercel-backend-and-bundle-co-managed** | URL service with asymmetric auth | Bundle reads/demotes via `c.api.invoke('participation.v1', ...)`; vercel backend promotes via host-auth REST call | Per-game per-player participant-vs-spectator state, entity assignments |

Long-term preset-boost ranking (boost by player time spent per game and
money spent per game) falls entirely in categories 1 and 2 — both
substrate or URL-service-authoritative. The bundle never has to be
trusted for those signals.

## Category 1 — substrate-derivable

The vercel backend tails the substrate's history stream:

```
GET /admin/history?cursor=<last-seen>
→ { events: [...], nextCursor: "..." }
```

For each event, the vercel backend updates its Postgres projection. The
event types that matter for projection:

| Event | Projection update |
|---|---|
| `game.created` | INSERT a row in `pax_games` |
| `game.deleted` | UPDATE `pax_games` set status='deleted' |
| `session.opened` | INSERT a row in `pax_sessions`; UPDATE `pax_games.lastActivityAt` |
| `session.closed` | UPDATE `pax_sessions` set disconnectedAt, reason |
| `bundle.flip.succeeded` | UPDATE `pax_games` set currentBundleName |
| `player.deleted` | UPDATE all related rows |
| `bundle.uploaded` | INSERT `pax_bundles` |
| `placement.accepted` | (optional) for shard-affinity analytics |

The projection is **eventually consistent** with the substrate. Read
queries against the projection may miss the last few events; queries
that need the absolute truth go to the substrate's admin API directly.

## Category 2 — URL-service-derivable

The vercel backend queries the URL service's own DB:

- `ai.chat.v1`'s `token_ledger` for spend per player per game.
- `moderation.audit.v1`'s audit log for verdict history.
- `participation.v1`'s state for participant/spectator mapping.

The substrate is not involved. These DBs are URL-service-internal; the
substrate sees only the wire-grain envelope going in and out.

## Category 3 — bundle-only-knowable

Some facts are knowable only to the bundle:

- The current round number.
- Whether a player has "completed" the round (their turn badge state).
- The game's narrative title (set by the bundle, may differ from the
  preset title).
- "Round-completed" events.

The bundle pushes these to the vercel backend via a `projection.sync.v1`
URL service:

```ts
// Inside the bundle
async function onRoundCompleted(roundNumber: number) {
  await c.api.invoke('projection.sync.v1', {
    op: 'roundCompleted',
    gameId: /* substrate fills in via context */,
    roundNumber,
  });
}
```

The `projection.sync.v1` URL service writes to the vercel backend's
Postgres directly:

```ts
app.post('/projection.sync.v1/invoke', async (req, res) => {
  const { args, context } = req.body;
  const { op } = args;
  switch (op) {
    case 'roundCompleted':
      await pg.query(
        'UPDATE pax_games SET currentRound = $1 WHERE gameId = $2',
        [args.roundNumber, context.gameId]
      );
      break;
    // ... other ops
  }
  return res.status(200).json({ result: { synced: true } });
});
```

The trust property here is **weak by design**: the bundle is the
authority for these facts, so if the bundle lies, the projection is
wrong. But these facts don't affect billing or ranking — they're
display-shaped. A bundle that lies about `currentRound` annoys players
who see a stale UI; it doesn't enable fraud.

For facts that affect billing or ranking (player time spent, money
spent), the substrate or the billing URL service is authoritative, and
the bundle is never consulted (categories 1 and 2).

## Category 4 — vercel-backend-and-bundle co-managed

Participation is the canonical example (see
[`participation-and-roles.md`](participation-and-roles.md)). The URL
service enforces the asymmetric write rule: bundles can demote,
vercel backend (with host auth) can promote.

The projection comes from the URL service's own DB.

## Anti-pattern: making the bundle the source of truth for trust-bearing facts

❌ "The bundle tells the vercel backend who's a participant via
`projection.sync.v1`."

A compromised bundle would just lie. Use a URL service with
asymmetric writes instead.

❌ "The bundle tells the vercel backend how much each player spent."

The billing URL service's ledger is the source of truth. The bundle's
view is downstream and can be wrong.

## Why the substrate doesn't ship a projection layer

A built-in projection sync sounded tempting but has the same problems as
billing primitives:

- The shape varies per operator. Pax-historia's Postgres schema is
  Pax-specific.
- The trust split between substrate / URL service / bundle for any
  given fact is operator policy.
- Maintenance and migrations of the projection schema are the
  vercel backend's lifecycle, not the substrate's.

So the substrate provides history (the source of truth) and the
admin API (queryable state); the vercel backend builds whatever
projection it wants on top.

## Cross-references

- [`subsystems/control-plane-admin-api.md`](../subsystems/control-plane-admin-api.md)
  — admin API + history stream
- [`contract/history-events.md`](../contract/history-events.md) — event
  shapes
- [`participation-and-roles.md`](participation-and-roles.md)
- [`billing-policy.md`](billing-policy.md)
- [`proofs/historia-default.md`](../proofs/historia-default.md) — the
  five-URL-service setup uses these patterns
