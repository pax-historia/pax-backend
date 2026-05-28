# `orchestration/control-plane/`

Shard registry + the admin REST surface from [plan](../../README.md)
§"Admin surface (REST)". In particular:

- Game lifecycle (`POST /admin/games`, `GET/DELETE /admin/games/:id`)
- The flip gate (`POST /admin/games/:id/bundle`, guarantee #15) returning
  `409 compatTagOutOfRange` with `{ blobCompatTag, bundleCompatTagsAccepted }`
- Compat-tag observability (`GET /admin/games/compat-tags`,
  `GET /admin/games/by-compat-tag/:tag`,
  `GET /admin/games/:id/bundle-compat?bundleName=...`)
- Allowed-players management
- Session observability (`GET /admin/games/:id/sessions`,
  `GET /admin/sessions/:sessionId`)
- Bundle upload (parses + validates `BundleManifest`; rejects if
  `compatTagProduced ∉ compatTagsAccepted`)
- Shard registry + drain
- API kind registration
- `GET /admin/history` (cursor-paginated; batch + live-tail)

**No ledger endpoints.** **No metadata endpoints.** See the plan's "Explicitly
NOT in the admin surface" subsection.

Stub.
