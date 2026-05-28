# Admin REST API

> Layer: **Reference catalog**

The substrate's admin REST surface. Every endpoint maps to one
substrate-owned unit; nothing depends on vercel-backend metadata;
nothing is a fancy query engine; nothing touches billing.

All endpoints require an `Authorization: Bearer <admin-token>` header
unless noted. Token rotation is operator-owned.

All responses are JSON. Errors are `{ error: "<code>", detail?: ... }`.

## Game lifecycle

### `POST /admin/games`

Create a game.

**Body**:

```jsonc
{
  "gameId": "string (cluster-wide unique)",
  "bundleName": "string (must reference an uploaded bundle)",
  "initialState": "<JSON value>" | undefined,
  "initialStateUrl": "string (HTTPS URL to JSON)" | undefined,
  "initialBlob": { "<key>": "<base64 bytes>" } | undefined,
  "initialBlobUrl": "string" | undefined,
  "allowedPlayers": ["string"] | undefined
}
```

Either `initialState` or `initialStateUrl` (or neither for empty). Same
for `initialBlob`. `allowedPlayers` defaults to empty.

**Responses**:

- `201 Created` `{ gameId, currentBundleName, status: "asleep" }`
- `400 manifestInvalid` if `bundleName` doesn't exist
- `409 gameIdExists` if `gameId` is taken

### `GET /admin/games/:id`

Basic game info.

**Response**:

```jsonc
{
  "gameId": "string",
  "currentBundleName": "string",
  "currentShardId": "string" | null,
  "status": "active" | "asleep" | "destroyed",
  "createdAt": "ISO timestamp",
  "lastActivityAt": "ISO timestamp" | null,
  "blobCompatTag": "string" | undefined,
  "allowedPlayerCount": "number",
  "connectedPlayerCount": "number"
}
```

### `DELETE /admin/games/:id`

Destroy the game.

- Ends any active sessions.
- Clears the per-game blob namespace.
- Removes from the active-game directory.
- Emits `game.deleted` history event.

**Response**: `202 Accepted`. Force-disconnect propagates via the parent
actor; vercel backend tails history to confirm completion.

### `GET /admin/games/:id/snapshot`

Fat introspection.

**Query**: `?includeBlob=false` (default `true`), `?apiLimit=N`
(default 100; limits recent api.invoke records).

**Response**:

```jsonc
{
  "game": { /* same as GET /admin/games/:id */ },
  "allowedPlayers": ["string"],
  "connectedSessions": [{ "sessionId", "playerId", "connectedAt" }],
  "state": "<JSON value>",
  "blob": { "<key>": "<base64 bytes>" } | null,
  "recentApiInvokes": [{ /* api.invoke.wire shape, last N */ }]
}
```

## Bundle flip

### `POST /admin/games/:id/bundle`

Flip the bundle pointer.

**Body**: `{ newBundleName: "string" }`

**Responses**:

- `200 OK` `{ previousBundleName, newBundleName }`
- `409 compatTagOutOfRange` `{ blobCompatTag, bundleCompatTagsAccepted }`
- `404 bundleNotFound`

On success: emit `bundle.flip.succeeded`. Create a 7-day rollback
backup. The next wake picks up the new bundle with `reason: 'upgrade'`.

### `GET /admin/games/:id/bundle-compat?bundleName=...`

Dry-run of the flip gate.

**Response**:

- `200 OK { ok: true }` — flip would succeed
- `200 OK { ok: false, blobCompatTag, bundleCompatTagsAccepted }` —
  flip would refuse

No side effects.

## Allowed players

### `POST /admin/games/:id/allowed-players/:playerId`

Add a player to the allowed-players set. Idempotent.

**Response**: `200 OK { added: true | false }`. Emits `allowed-players.added`.

### `DELETE /admin/games/:id/allowed-players/:playerId`

Remove from allowed-players. Force-disconnects any live sessions for
this player on this game.

**Response**: `202 Accepted`. Emits `allowed-players.removed` and (if
the player had a live session) `session.forceDisconnect`.

### `GET /admin/games/:id/allowed-players`

List allowed players.

**Response**: `{ allowedPlayers: ["playerId"] }`

### `GET /admin/games/:id/connected-players`

Live connected sessions.

**Response**: `{ sessions: [{ sessionId, playerId, connectedAt }] }`

## Players (sugar)

### `GET /admin/players/:playerId/games`

Every game where this player is allowed.

**Response**: `{ gameIds: ["string"] }`

### `DELETE /admin/players/:playerId`

Atomic: for every game where the player is allowed, run the
`removeAllowedPlayer` flow (which force-disconnects). Emits
`player.deleted` audit event.

**Response**: `202 Accepted { affectedGames: ["gameId"] }`.

Does NOT touch any billing state because the substrate has none.

## Compatibility-tag observability

### `GET /admin/games/compat-tags`

Histogram of `blobCompatTag` across all games.

**Response**:

```jsonc
{
  "histogram": { "historia:v3": 120, "historia:v4": 800, "historia:v5": 80 },
  "untagged": 5
}
```

### `GET /admin/games/by-compat-tag/:tag`

Paginated list of games at a given tag.

**Query**: `?cursor=<opaque>`, `?limit=N`

**Response**: `{ games: [{ gameId, currentBundleName, lastActivityAt }], nextCursor: "..." | null }`

## Session observability

### `GET /admin/games/:id/sessions`

Historical session records.

**Query**: `?from=<ISO>`, `?to=<ISO>`, `?playerId=...`

**Response**:

```jsonc
{
  "sessions": [
    {
      "sessionId": "...",
      "playerId": "...",
      "connectedAt": "ISO",
      "disconnectedAt": "ISO" | null,
      "reason": "left" | "..." | null,
      "shardId": "..."
    }
  ]
}
```

### `GET /admin/sessions/:sessionId`

Single session lookup.

**Response**: `{ session: { /* same fields */ } }`

## Bundles

### `POST /admin/bundles/:bundleName`

Upload a bundle. Write-once.

**Body**:

```jsonc
{
  "manifest": {
    "compatTagProduced": "string",
    "compatTagsAccepted": ["string"],
    "runtimeContractRequired": 1
  },
  "source": "string (the compiled bundle JS)"
}
```

**Responses**:

- `201 Created { bundleName, contentSha256, sizeBytes }`
- `400 manifestInvalid` with details
- `409 bundleNameTaken`

### `GET /admin/bundles/:bundleName`

Get bundle metadata + source.

**Response**: `{ bundleName, uploadedAt, manifest, contentSha256, sizeBytes, source }`.

### `DELETE /admin/bundles/:bundleName`

Delete. Refused if anything references the bundle.

**Responses**:

- `204 No Content`
- `409 bundleInUse { referencingGames: ["gameId"], rollbackBackups: ["gameId"] }`

## Shards

### `GET /admin/shards`

List shards.

**Response**:

```jsonc
{
  "shards": [
    {
      "shardId": "string",
      "status": "healthy" | "draining" | "unhealthy",
      "acceptingWakes": true,
      "currentGameCount": 42,
      "version": "string",
      "runtimeContractsSupported": [1, 1],
      "lastSeenAt": "ISO"
    }
  ]
}
```

### `GET /admin/shards/:id`

Single shard detail.

### `POST /admin/shards/:id/drain`

Start drain. Sets `acceptingWakes: false`; in-flight games run to
natural sleep.

**Response**: `202 Accepted`. Emit `shard.drain.started`.

### `DELETE /admin/shards/:id/drain`

Un-drain (clear the flag).

**Response**: `200 OK`.

## API kinds

### `POST /admin/api-kinds`

Register a kind → URL.

**Body**: `{ kindName: "string", url: "string" }`

**Responses**:

- `201 Created`
- `409 kindAlreadyRegistered`
- `400 invalidUrl`

### `GET /admin/api-kinds`

List all registrations.

**Response**: `{ kinds: [{ kindName, url, registeredAt }] }`

### `GET /admin/api-kinds/:kindName`

Single kind lookup.

**Response**: `{ kindName, url, registeredAt }` or `404 apiKindNotFound`.

### `DELETE /admin/api-kinds/:kindName`

Unregister. Subsequent `c.api.invoke` calls for this kind fail
`kindUnknown`.

**Response**: `204 No Content`.

## History

### `GET /admin/history`

Paginated structured event log.

**Query**:

- `?cursor=<opaque>` — pagination cursor
- `?limit=N` (default 1000, max 10000)
- `?event=<eventName>` — filter by event
- `?gameId=<id>` — filter by game
- `?playerId=<id>` — filter by player
- `?sessionId=<id>` — filter by session
- `?shardId=<id>` — filter by shard
- `?from=<ISO>` / `?to=<ISO>` — time range
- `?follow=true` — live-tail mode (long-polling)

**Response**:

```jsonc
{
  "events": [ /* see reference/event-schema.md */ ],
  "nextCursor": "opaque string" | null
}
```

Cursor-stable: the same cursor always returns the same page (idempotent
re-read).

## Host events

### `POST /admin/games/:id/host-event`

Deliver an event to the bundle's `onHostEvent` handler.

**Body**:

```jsonc
{
  "eventType": "string",
  "payload": "<JSON value>",
  "wakeOnDelivery": false
}
```

**Responses**:

- `202 Accepted` — event queued (durable if `wakeOnDelivery: true`,
  best-effort otherwise)
- `404 gameNotFound`
- `503 hostEventQueueFull` (rare; only if Redis is unreachable)

Guarantee #17 commits to at-least-once delivery for `wakeOnDelivery:
true` within 30-day TTL.

## Placement (substrate-internal)

`POST /placement` is **not** part of the admin surface. It's called by
the vercel platform frontend wrapper directly (via the vercel backend's
proxy in some flows) to obtain a `placementToken` + `webSocketUrl`. See
[`subsystems/placement-and-wake.md`](../subsystems/placement-and-wake.md).

## What's NOT here

- No ledger endpoints. No `POST /admin/ledger/mutate`, no
  `GET /admin/ledger/balance`, no debit log.
- No webhook subscription endpoint. Vercel backend polls or tails
  `GET /admin/history`.
- No `forceDisconnect` that kicks without removing from
  allowed-players.
- No metadata endpoints (game titles, preset names, user profiles).
- No analytics or stats endpoints.
- No multi-game atomic operations beyond `DELETE /admin/players/:playerId`.
- No spectator / role / membership-mode endpoints.

See [`vision/non-goals.md`](../vision/non-goals.md).

## Cross-references

- [`error-codes.md`](error-codes.md) — full taxonomy of error responses
- [`event-schema.md`](event-schema.md) — `GET /admin/history` payload
- [`subsystems/control-plane-admin-api.md`](../subsystems/control-plane-admin-api.md) — implementation
- [`contract/bundle-compatibility.md`](../contract/bundle-compatibility.md) — flip gate
