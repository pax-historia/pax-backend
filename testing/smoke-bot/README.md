# `testing/smoke-bot/` — `@pax-backend/smoke-bot`

The vertical-smoke driver. The end-to-end gate the substrate must pass
before any release. See [`../README.md`](../README.md) for the broader
rules about the `testing/` zone.

## What it does

1. Seeds Redis with a `BundleRecord` (`bundles:hello-ws-echo`) and a
   `GameRecord` (`games:<gameId>`) so the placement router has enough
   state to decide.
2. `POST <router>/placement`. Expects a signed JWT and the full
   `webSocketUrl` to open against the Broker shard.
3. Opens the WebSocket directly with the placement token in the URL.
   Expects a `ready`
   frame from the bundle's `onPlayerConnect` handler with a
   substrate-generated `sessionId` (`ses_<32 hex>`).
4. Sends `{type:'echo', body:{...}}`. Expects an `echo` frame back with
   the same `sessionId` and `seq=1`.
5. Reads the history tail (only events written during this smoke — see
   "Performance" below) and asserts the expected sessionId-threaded
   channel calls landed: `session.opened`, `ws.send`, `onPlayerMessage`,
   `ws.send`, `session.closed`, plus at least 2 `log.emit` entries
   from the bundle.

## Configuration

All via env vars so the same driver targets localhost or (later) Fly:

| Env | Default | Purpose |
|---|---|---|
| `PAX_ROUTER_URL` | `http://127.0.0.1:9080` | Placement router base URL |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Where to seed bundle/game keys |
| `PAX_HISTORY_PATH` | `<repo>/var/history.jsonl` | Where the Broker writes; we read the smoke's tail |
| `PAX_SMOKE_GAME_ID` | `smoke-<timestamp>` | Override for deterministic re-runs |
| `PAX_SMOKE_PLAYER_ID` | `alice` | Player id baked into the JWT |
| `PAX_SMOKE_BUNDLE` | `hello-ws-echo` | Which bundle to seed |

## Performance

The smoke captures `stat(HISTORY_PATH).size` at start and reads from
that offset at the end, so its assertion time is O(events-this-smoke),
not O(total-history-bytes). The history file may have accumulated MBs
of events across the dev session; the smoke stays fast either way.

## Run

```bash
# Local stack must be up first (./scripts/dev/local-up.sh)
pnpm smoke

# Or: target a Fly deployment later
PAX_ROUTER_URL=https://pax-backend-control.fly.dev \
PAX_HISTORY_PATH=/tmp/fly-history.jsonl \
  pnpm smoke
```
