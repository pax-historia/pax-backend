# `participation.v1`

> **Status: schema-only spec.** Part of the historia-default proof (see
> [`docs/dev/port-from-paxhistoria.md`](../../../docs/dev/port-from-paxhistoria.md)).
> No live HTTP server runs for the proof — bundle calls are replayed from
> canned `api-responses` fixtures via the scenario-runner's existing
> replay-mode short-circuit. Host-initiated writes (promotion) are
> simulated by the scenario harness firing host events into the substrate.

URL service kind `participation.v1` is the **canonical store for per-game
per-player participation state** (participant vs spectator + optional
entity assignment). It is the trust-seam for the rule *spectators never
get billed for AI*: the AI URL service reads this store before billing,
and the bundle cannot bypass the spectator block.

The substrate stays participation-agnostic — there is no
`AllowedPlayer.participant` flag, no substrate-side role registry, and no
`triggeringSessionRoleId` in the gateway envelope. All participation
state lives here.

See
[`docs/dev/port-from-paxhistoria.md`](../../../docs/dev/port-from-paxhistoria.md)
§2c for the asymmetric write rules and the end-to-end claim flow.

## Stored shape

```ts
type ParticipationRecord = {
  gameId: string;
  playerId: string;
  participant: boolean;
  entityId?: string;            // opaque; bundle-defined
  lastChangedAt: number;
  lastChangedBy: "host" | "bundle" | "player";
};
```

One row per `(gameId, playerId)`. Owned by the operator (paxhistoria
Postgres in the reference implementation; could be Redis if read
latency matters more than write durability).

## Ops

```ts
type ParticipationV1Args =
  | { op: "get"; playerId: string; gameId: string }
  | { op: "setSpectator"; playerId: string; gameId: string; reason: string }
  | { op: "setParticipant"; playerId: string; gameId: string; entityId?: string };
```

### Asymmetric write rules (load-bearing)

| Op | Bundle can call? | Host can call? | Player can call directly? |
|---|---|---|---|
| `get` | Yes | Yes | Via host UI only |
| `setSpectator` | Yes (via `c.api.invoke`) | Yes (host auth token) | Via host's "Spectate" button, which calls `setSpectator` on their behalf |
| `setParticipant` | **No — returns `403 hostOnly`** | Yes (host auth token, required) | Via host's claim flow, which calls `setParticipant` on their behalf after the host's own token-balance check |

The trust gate: **promotion to participant only happens via host call
with a host auth token.** The bundle has no path to promote — even if
compromised, it cannot make a non-consenting user a billable participant.
The bundle CAN demote (a strict downgrade is always safe).

The AI URL service `ai.chat.v1` calls `get` before every billable call
and refuses to bill any player marked spectator
(`{ ok: false, errorCode: "playerIsSpectator" }`). This is the final
defense even if a compromised bundle ignores everything else.

## Results

```ts
type ParticipationV1Result =
  | // get
    { ok: true;
      participant: boolean;
      entityId?: string;
      lastChangedAt: number;
      lastChangedBy: "host" | "bundle" | "player"; }
  | // setSpectator / setParticipant success
    { ok: true; appliedAt: number }
  | // any op
    { ok: false;
      errorCode: "hostOnly" | "notFound" | "validationError" | "providerError";
      detail?: unknown; };
```

## Side effect: host-event push

On every successful write (`setSpectator` or `setParticipant`), the URL
service MUST POST to the substrate's host-event channel:

```
POST /admin/games/:gameId/host-event
{
  "eventType": "participationChanged",
  "payload": {
    "playerId": "...",
    "participant": boolean,
    "entityId": "...?",
    "changedBy": "host" | "bundle" | "player"
  }
}
```

This delivers `onHostEvent({ eventType: "participationChanged", payload })`
to the bundle (best-effort while-awake — `wakeOnDelivery: false`, the
default). If the game is asleep, the event is dropped; the bundle
re-fetches fresh state from `participation.v1.get` on next wake. See
[`substrate-additions-for-historia-port.md`](../../../docs/dev/substrate-additions-for-historia-port.md)
§2 for the host-event channel spec.

The URL service uses the substrate's admin token to call the host-event
endpoint (it has host-equivalent trust).

## Trust gates (this service is itself the trust gate)

`participation.v1` is the canonical source of truth for participant
state; there is no upstream service to consult. Its own server-side
auth check on `setParticipant` (host token required, bundle calls
rejected) IS the gate that the rest of the system depends on.

## End-to-end claim flow

For reference; full walkthrough lives in
[`docs/dev/port-from-paxhistoria.md`](../../../docs/dev/port-from-paxhistoria.md)
§2c.

1. Player connects WS as spectator (default).
2. Bundle pushes `c.ws.send(playerId, { type: "entity_options", options: [...] })`
   from `onPlayerConnect`.
3. Player's frontend renders the picker, user clicks one entity.
4. Frontend calls host's `/api/games/:id/claim-entity` endpoint.
5. Host runs token-balance check (paxhistoria's existing
   `/api/live/tokens/check`).
6. Host calls `participation.v1.setParticipant` with host auth token.
7. `participation.v1` writes the record and POSTs `participationChanged`
   to the substrate's host-event channel.
8. Substrate delivers `onHostEvent` to the bundle.
9. Bundle updates internal state, broadcasts via `c.ws.send`.
10. Next time bundle calls `c.api.invoke('ai.chat.v1', { splitPlayerIDs: [thisPlayer] })`,
    `ai.chat.v1` calls `participation.v1.get`, sees `participant: true`,
    bills the player.

## Authoring fixtures for scenarios

Place canned `get` responses in
`examples/bundles/historia-default/scenarios/<scenario>/fixtures/api-responses/`,
keyed by request fingerprint. Suggested coverage per scenario:

- A `get` response showing `participant: true` for each participating
  player.
- A `get` response showing `participant: false` for each spectator.
- A successful `setSpectator` response when the bundle demotes.
- A `setParticipant` host-only failure (for the `spectator-billing-block`
  scenario, where the bundle is intentionally buggy and tries to
  self-promote).

For scenarios that simulate host-initiated promotion (e.g.,
`role-claim-flow`), the scenario workload's `clients/workload.mts` phases
include a `fire-host-event` step that POSTs directly to the substrate's
host-event endpoint with
`{ eventType: "participationChanged", payload: { ... } }` — no
`participation.v1` call required from the scenario harness.
