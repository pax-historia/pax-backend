# `projection.sync.v1`

> **Status: schema-only spec.** Part of the historia-default proof (see
> [`docs/dev/port-from-paxhistoria.md`](../../../docs/dev/port-from-paxhistoria.md)).
> No live HTTP server runs for the proof — bundle calls are replayed from
> canned `api-responses` fixtures via the scenario-runner's existing
> replay-mode short-circuit. Production paxhistoria's
> [`/api/live-games-db/*`](../../../../paxhistoria/app/api/live-games-db/)
> routes stay where they are.

URL service kind `projection.sync.v1` is the operator-owned endpoint the
[`historia-default`](../../bundles/historia-default/) bundle calls
explicitly to notify the host of **bundle-only-knowable** game metadata
changes (game status, current round display, player-ready, title, round
completion).

This is the explicit-API path that replaces paxhistoria's
fire-and-forget calls to `/api/live-games-db/{sync-status, player-ready,
round-completed, player-joined, player-left}`. It exists because the host
needs these facts for its game-list UI and stats, AND because trusting
the substrate's history stream is the wrong default for facts that only
the bundle knows.

See
[`docs/dev/port-from-paxhistoria.md`](../../../docs/dev/port-from-paxhistoria.md)
§2b for the three-bucket model: substrate-derivable vs.
AI-service-derivable vs. bundle-only-knowable. This URL service is the
bundle-only-knowable bucket.

## Args

One endpoint, dispatched on the `op` discriminator:

```ts
type ProjectionSyncV1Args =
  | { op: "statusChanged";  status: "in-progress" | "ended" }
  | { op: "roundDisplay";   displayedRound: number }
  | { op: "playerReady";    playerId: string; ready: boolean }
  | { op: "titleChanged";   title: string }
  | { op: "roundCompleted"; round: number; completedAt: number };
```

The bundle calls these explicitly on state changes (e.g., after
committing a round, after a player marks themselves ready, after admin
renames the game). The host's implementation writes the matching Postgres
projection row.

## Result

```ts
type ProjectionSyncV1Result =
  | { ok: true }
  | { ok: false; errorCode: "validationError" | "providerError"; detail?: unknown };
```

Fire-and-forget on the bundle side is fine; the bundle does not gate
game logic on the response (paxhistoria today doesn't either — these are
all `/api/live-games-db/*` calls made without awaiting).

## Trust gates

None billing-shaped. The bundle MAY exaggerate (e.g., claim
`roundCompleted` events that didn't really happen), so:

- **Anything used for preset-boost ranking** should NOT trust
  `projection.sync.v1`. Ranking signals (player-time, money-spent) are
  substrate-derivable and AI-service-derivable per §2b — both
  authoritative.
- **Round-completed anti-fraud** is not a concern for now; round count
  is being removed from preset ranking, so falsifying it only irritates
  players (no malicious benefit). If round count comes back to ranking
  later, add a cross-check job that compares `roundCompleted` ops
  against `ai.chat.v1`'s call count for round-completion-shaped
  requests.

## What this URL service does NOT do

| Concern | Where it lives |
|---|---|
| Player session times (connected/disconnected) | Substrate-derivable: host tails `/admin/history` for `session.opened` / `session.closed` events |
| Allowed-player roster changes | Host already knows when it calls substrate's `POST /admin/games/:id/allowed-players/:playerId` — projection happens synchronously in the host's own code, not via this service |
| Game-create / game-delete | Substrate-derivable: `game.created` / `game.deleted` history events |
| Bundle-pointer flips | Substrate-derivable: `bundle.flip.succeeded` / `bundle.loaded` history events |
| Per-player AI spend | `ai.chat.v1`'s own `llm_logs` + `token_ledger` is the trusted source |

## Authoring fixtures for scenarios

Place canned `{ ok: true }` responses in
`examples/bundles/historia-default/scenarios/<scenario>/fixtures/api-responses/`
for every op the scenario triggers. These are mostly trivial — the
bundle doesn't depend on the response content, just on the call having
gone out.
