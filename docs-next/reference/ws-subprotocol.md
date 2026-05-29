# WebSocket sub-protocol

> Layer: **Reference catalog**

The wire format between the vercel platform frontend wrapper (the
browser app) and the Broker on whichever shard hosts a given game. This
sub-protocol is **not** versioned independently — it is governed by the
substrate's runtime contract version (Axis A).

## Handshake

The frontend obtains a `webSocketUrl` and a `placementToken` from the
placement router:

```http
POST <router>/placement
Content-Type: application/json
{
  "gameId": "string",
  "playerId": "string",
  "runId": "string" | undefined,
  "traceparent": "string" | undefined
}

→ 200 OK
{
  "webSocketUrl": "wss://shard-N.pax-backend-shards.fly.dev/gateway/pax-game?...",
  "placementToken": "<HS256 signed token>"
}
```

The router-built `webSocketUrl` already includes `placementToken` as a
query-string parameter. The JWT travels in the query string (not a header)
because browser WebSocket APIs do not generally support custom request
headers.

On Fly, the URL uses the public shard app hostname. If Fly Proxy first
delivers the upgrade request to a Broker whose `shardId` differs from the
signed JWT's target shard, that Broker returns a `Fly-Replay:
instance=<target-machine>` response before negotiating the WebSocket
upgrade. The target Broker then handles the upgrade and verifies the JWT.

## JWT verification

The Broker on the receiving shard:

1. Reads `placementToken` from the query string. (`token` is accepted as a
   legacy alias.)
2. Verifies the signature against `PAX_JWT_SECRET` (HS256).
3. Verifies `exp` (expiry).
4. Extracts `gameId`, `playerId`, `traceId?`, `runId?`, `shardId`,
   plus pass-through claims (Firebase, etc.).
5. Verifies the `gameId` from the JWT matches a game routed to this shard.
6. Verifies `playerId ∈ allowedPlayers(gameId)`.

On signature or expiry failure: WS close with code 4401. On wrong-shard,
wrong-game, or not-allowed failure: WS close with code 4403. When the
Broker has enough game context, it emits a `connection.refused` history
event.

See [`reference/jwt-claims.md`](jwt-claims.md) for the JWT shape.

## After accept — server-to-client `ready` frame

Immediately after accepting the WS, the Broker sends a `ready` frame
containing the substrate-generated `sessionId`:

```jsonc
{
  "type": "ready",
  "sessionId": "string (substrate-generated, opaque, unforgeable)",
  "connectedAt": "ISO timestamp",
  "playerId": "string",
  "gameId": "string"
}
```

The frontend uses `sessionId` for client-side correlation (it appears
on subsequent server-sent frames).

The Broker emits `session.opened` to history at the same moment.

After `ready`, the Broker calls the bundle's `onPlayerConnect` hook.

## Client → server: player messages

The frontend sends arbitrary JSON-shaped messages. Each message is one
WS text frame.

```jsonc
{
  "type": "<bundle-defined>",
  "body": "<bundle-defined>"
}
```

The substrate doesn't impose any structure on the body — it's
JSON-shaped and that's it. The bundle's `onPlayerMessage` handler
receives the full parsed body.

The Broker:

1. Parses the frame as JSON. Malformed JSON → drop the message; emit
   `ws.recv.malformed` history.
2. Assigns a per-session monotonic `seq` (starts at 0 on `session.opened`,
   increments).
3. Dispatches to the game's isolate as `onPlayerMessage(c, { playerId,
   sessionId, seq, body })`.
4. Emits `onPlayerMessage` history with the body.

The substrate enforces idempotency: `(playerId, seq)` is never delivered
twice (guarantee #6). On rare restart cases the substrate may **drop** a
message that was already delivered; it never duplicates.

## Server → client: bundle messages

The bundle's `c.ws.send(target, body)` produces frames the Broker sends
to one or more connected sessions (fan-out is Broker-side).

`target` is `'all'`, a `playerId`, or a `readonly string[]` of player ids.

Frame format:

```jsonc
{
  "type": "<bundle-defined>",
  "sessionId": "<recipient sessionId>",
  "body": "<bundle-defined>"
}
```

The `sessionId` lets the frontend correlate (e.g. for "your message vs
another player's message" routing).

## Server → client: lifecycle frames

The substrate occasionally sends frames the bundle did not author —
specifically `disconnect` notices when the substrate is closing the
connection:

```jsonc
{
  "type": "disconnect",
  "sessionId": "string",
  "reason": "left" | "timedOut" | "removedFromAllowedPlayers" | "shardEvicted" | "gameDeleted"
}
```

These are informational; the frontend may show a UX based on the
reason. The substrate closes the underlying WS frame immediately after.

## Close codes

| Code | Reason | When |
|---|---|---|
| `1000` | Normal closure | Frontend or substrate cleanly closed |
| `1001` | Going away | Substrate shutting down |
| `4401` | Unauthorized | JWT signature failed or expired |
| `4403` | Forbidden | Wrong shard, wrong game, or `playerId` not in `allowedPlayers` |
| `4404` | Game not found | `gameId` doesn't exist or has been deleted |
| `4503` | Service unavailable | Shard is unhealthy or draining (frontend should re-call placement) |
| `4404 + reason: 'gameDeleted'` | Game was deleted | Frontend shows "game ended" UX |

Close codes in the `4xxx` range are substrate-defined application
codes (per RFC 6455 §7.4.2 reserved-for-applications).
When the Broker rejects a WebSocket before the Fly proxy has established
the client-side socket, the public client can see the proxy's
service-unavailable close instead; `connection.refused` history remains
the authoritative typed reason when the Broker had game context.

## Reconnect semantics

If the WS closes for any reason except deliberate frontend closure or
`gameDeleted`, the frontend should:

1. Re-call `POST /placement` to get a fresh `placementToken` and `webSocketUrl`.
2. Reopen the WS.
3. Receive a new `sessionId` in the `ready` frame.

**Sessions are not resumable.** A reconnect always gets a fresh
`sessionId`. The bundle sees a new `onPlayerConnect`.

For reconnects within the 60s sleep-grace window, the same Broker (same
shard) accepts the new session; the game's isolate stays resident across
the brief gap.

## Heartbeats

The substrate sends a server-initiated WS ping every 30 seconds. The
frontend MUST respond with pong (browsers do this automatically). If
no pong arrives within 90 seconds, the substrate closes the WS with
`reason: 'timedOut'`.

## Frame size limits

| Direction | Limit |
|---|---|
| Inbound (client → server) | 1 MB per frame |
| Outbound (server → client) | Capped by the `bandwidth-bytes-per-sec` compute budget |

Inbound frames exceeding 1 MB are dropped; substrate emits
`ws.recv.oversized`. The frontend should chunk large payloads via
multiple messages.

## What the substrate does NOT support

- **Binary frames.** All frames are JSON text. Bundles that need
  binary data (audio, images) put base64 in JSON or use `c.api.invoke`
  to a URL service that returns a signed Tigris URL.
- **WebSocket subprotocols** beyond JSON text. No MessagePack
  negotiation, no graphql-ws, no socket.io.
- **Channel-style subscriptions.** The substrate exposes
  `c.ws.send(target, body)` only. Bundles route topics inside their
  own WS handler (cheap; common pattern).
- **Server-sent reconnect tokens** (e.g. for fast-resume). Reconnect
  always re-runs placement.

## Cross-references

- [`contract/creator-runtime.md`](../contract/creator-runtime.md) — `c.ws.send`
- [`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md) —
  session lifecycle hooks
- [`jwt-claims.md`](jwt-claims.md) — JWT shape
- [`placement-api.md`](placement-api.md) — `POST /placement` wire reference
- [`subsystems/broker.md`](../subsystems/broker.md) — WS server side
- [`subsystems/placement-and-wake.md`](../subsystems/placement-and-wake.md) — placement flow
- [`vision/guarantees.md`](../vision/guarantees.md) #2, #3, #6
