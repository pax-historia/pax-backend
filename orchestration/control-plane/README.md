# `orchestration/control-plane/`

Shard registry + the admin REST surface from [plan](../../README.md)
§"Admin surface (REST)". In particular:

- Game lifecycle (`POST /admin/games`, `GET/DELETE /admin/games/:id`)
- Player deletion sugar (`DELETE /admin/players/:playerId`)
- The flip gate (`POST /admin/games/:id/bundle`, guarantee #15) returning
  `409 compatTagOutOfRange` with `{ blobCompatTag, bundleCompatTagsAccepted }`
  and retaining a seven-day rollback backup on successful bundle changes
- Compat-tag observability (`GET /admin/games/compat-tags`,
  `GET /admin/games/by-compat-tag/:tag`,
  `GET /admin/games/:id/bundle-compat?bundleName=...`)
- Allowed-players management
- Session observability (`GET /admin/games/:id/sessions`,
  `GET /admin/sessions/:sessionId`)
- Game snapshots (`GET /admin/games/:id/snapshot`) with recent
  `api.invoke.wire` records preferred from history and falling back to the
  gateway JSONL record file
- Bundle upload/delete (parses + validates `BundleManifest`; rejects if
  `compatTagProduced ∉ compatTagsAccepted`; refuses bundle delete while games
  still reference it)
- Shard registry + drain (`GET /admin/shards`, `GET /admin/shards/:id`,
  `POST /admin/shards/:id/drain`, `DELETE /admin/shards/:id/drain`). Drain
  ACKs only after every parent-actor on the shard has force-flushed each
  running game's pending `c.state` writes to Tigris, so the redeploy
  runbook can rely on zero state loss on planned moves (see
  [README](../../../README.md) guarantee #11 and
  [docs/ops/redeploy-runbook.md](../../docs/ops/redeploy-runbook.md)).
- API kind registration (`POST /admin/api-kinds`, `GET /admin/api-kinds`,
  `GET /admin/api-kinds/:kindName`, `DELETE /admin/api-kinds/:kindName`)
- `GET /admin/history` (cursor-paginated; batch + live-tail)
- `GET /metrics` (Prometheus text counters for total HTTP requests
  and requests returned through the error handler)

**No ledger endpoints.** **No metadata endpoints.** See the plan's "Explicitly
NOT in the admin surface" subsection.

The current pass wires the shard registry and drain intent through Redis.
Drained shards continue serving in-flight games, but parent self-registration
publishes `acceptingWakes=false` so placement stops choosing them for new
wakes.

`GET /admin/games/by-compat-tag/:tag` accepts `cursor` and `limit` query
parameters and returns `{ cursor, limit, nextCursor, games }`, ordered by
`gameId`. Use the literal tag `untagged` for games that have not stamped a
blob compatibility tag yet.
