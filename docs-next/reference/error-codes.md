# Error codes

> Layer: **Reference catalog**

Every substrate-owned error code, where it can fire, and what it means.

All substrate error responses follow the shape:

```jsonc
{ "error": "<code>", "detail"?: <opaque> }
```

`detail` is free-form and may include the offending values for
diagnostics. The `error` string is the canonical machine-readable code
that scripts dispatch on.

## API channel (`c.api.invoke`)

Returned to the bundle inside `{ ok: false, error: ... }`:

| Code | When | Notes |
|---|---|---|
| `kindUnknown` | The `kind` argument is not in the gateway's URL registry | Vercel backend must `POST /admin/api-kinds` to register first |
| `providerError` | URL service returned non-2xx, timed out, or was unreachable | `detail` contains the URL service's response body (if any) |
| `apiRateExceeded` | The per-game `api-invocations-per-min` budget would be exceeded | URL service is **not** contacted |
| `replayCoverageGap` | Replay mode and no fixture matches the request fingerprint | Hard failure; not retryable; never falls through to live |

## Compute budgets

Returned to the bundle inside `{ ok: false, error: ... }`:

| Code | Channel | Budget |
|---|---|---|
| `bandwidthExceeded` | `c.ws.send` | `bandwidth-bytes-per-sec` |
| `rateExceeded` | `c.ws.send` | `ws-messages-per-sec` |
| `targetInvalid` | `c.ws.send` | Target shape is not `'all'`, a player id, or a player-id array |
| `targetNotConnected` | `c.ws.send` | Target player id is not currently connected to this game |
| `sizeExceeded` | `c.state.write`, `c.blob.put` | `state-bytes` or `blob-bytes` |
| `keyCountExceeded` | `c.blob.put` | `blob-keys` |
| `apiRateExceeded` | `c.api.invoke` | `api-invocations-per-min` (also listed above) |

Two budgets are not bundle-visible (the substrate enforces them by
killing the child / handler):

- `cpu-ms-per-tick` — emits `child.handlerError` with `code:
  'handlerTimeout'`
- `memory-bytes` — child OOM → restart with
  `cold-restart-after-crash`, `errorClass: 'oom'`

## Storage

| Code | Channel | When |
|---|---|---|
| `sizeExceeded` | `c.state.write`, `c.blob.put` | Size budget exceeded |
| `keyCountExceeded` | `c.blob.put` | Key-count budget exceeded |
| `storageUnavailable` | All storage ops | Tigris unreachable / 5xx; retryable |

## WS send

| Code | When |
|---|---|
| `bandwidthExceeded` | `bandwidth-bytes-per-sec` budget |
| `rateExceeded` | `ws-messages-per-sec` budget |
| `serializationFailed` | `body` is not JSON-serializable (returned synchronously before IPC) |
| `targetInvalid` | target is not `'all'`, a player id, or a player-id array |
| `targetNotConnected` | one or more requested target player ids have no connected session |

## Admin REST

Returned as HTTP error responses:

### 400 Bad Request

| Code | Endpoint | When |
|---|---|---|
| `manifestInvalid` | `POST /admin/bundles/:bundleName` | Manifest fails schema validation |
| `invalidUrl` | `POST /admin/api-kinds` | `url` is not a valid HTTP(S) URL |
| `invalidGameIdFormat` | `POST /admin/games` | `gameId` violates the format rules |
| `invalidBody` | Any | JSON parsing failed |

### 401 Unauthorized

| Code | Endpoint | When |
|---|---|---|
| `unauthorized` | All admin endpoints | Missing or invalid `Authorization` header |

### 403 Forbidden

| Code | Endpoint | When |
|---|---|---|
| `forbidden` | All admin endpoints | Token valid but lacks permission (reserved for future scoped tokens) |

### 404 Not Found

| Code | Endpoint | When |
|---|---|---|
| `gameNotFound` | Game endpoints | Game doesn't exist or has been deleted |
| `bundleNotFound` | Bundle endpoints | Bundle isn't registered |
| `apiKindNotFound` | `GET /admin/api-kinds/:kindName` | Kind isn't registered |
| `shardNotFound` | `GET /admin/shards/:id` | Shard isn't registered |
| `sessionNotFound` | `GET /admin/sessions/:sessionId` | No matching session in history |

### 409 Conflict

| Code | Endpoint | When |
|---|---|---|
| `gameIdExists` | `POST /admin/games` | `gameId` taken |
| `bundleNameTaken` | `POST /admin/bundles/:bundleName` | Bundle name taken (write-once) |
| `kindAlreadyRegistered` | `POST /admin/api-kinds` | Kind already registered |
| `bundleInUse` | `DELETE /admin/bundles/:bundleName` | Bundle referenced by games or rollback backups |
| `compatTagOutOfRange` | `POST /admin/games/:id/bundle` | Flip refused; body contains `{ blobCompatTag, bundleCompatTagsAccepted }` |
| `contractOutOfRange` | `POST /placement` | Placement refused because no shard supports the bundle's contract |

### 503 Service Unavailable

| Code | Endpoint | When |
|---|---|---|
| `directoryUnavailable` | `POST /placement` | Redis directory unreachable |
| `noEligibleShards` | `POST /placement` | All shards full, draining, or unhealthy |
| `bundleMetadataUnavailable` | `POST /placement` | Control plane bundle lookup failed |
| `hostEventQueueFull` | `POST /admin/games/:id/host-event` | Durable queue Redis unreachable |
| `storageUnavailable` | Storage-touching endpoints | Tigris unreachable |

## URL service ↔ substrate (gateway envelope)

Substrate-mapped failures returned to the bundle (already listed above):

- `kindUnknown` → substrate doesn't reach the URL service
- `apiRateExceeded` → substrate doesn't reach the URL service
- `replayCoverageGap` → substrate doesn't reach the URL service
- `providerError` → URL service returned non-2xx; substrate preserves
  the URL service's `error` and body in `detail`

URL-service-side error codes (the strings inside `providerError.detail`)
are **operator-defined**. Common conventions:

| Status | Convention |
|---|---|
| `400` | Malformed `args` or `context` from substrate |
| `403` | Trust-rule violation (`playerNotConnected`, `playerIsSpectator`, etc.) |
| `404` | Referenced entity not found |
| `409` | Idempotency-key conflict |
| `429` | URL-service-side rate limit |
| `500` | URL service internal error |
| `503` | Downstream vendor unavailable |

## WS sub-protocol

WebSocket close codes:

| Code | Reason |
|---|---|
| `1000` | Normal closure |
| `1001` | Going away (substrate shutting down) |
| `4401` | JWT invalid or expired |
| `4403` | Wrong shard, wrong game, or player not in `allowedPlayers` |
| `4404` | Game not found or deleted |
| `4503` | Shard unhealthy or draining |

## Handler error codes

Emitted in `child.handlerError` history events:

| `code` | When |
|---|---|
| `handlerTimeout` | Handler ran longer than `cpu-ms-per-tick` |
| `handlerException` | Handler threw an unhandled error |

## Bundle load failures

Emitted in `bundle.loaded.failed` history events:

| `cause` | When |
|---|---|
| `parseError` | Bundle source failed to parse as JS |
| `manifestInvalid` | `defineBundle()` call rejected the manifest (substrate-side validation runs again at boot) |
| `evalError` | Bundle source ran but threw during module evaluation |

## Cross-references

- [`contract/external-api-channel.md`](../contract/external-api-channel.md)
- [`contract/compute-budgets.md`](../contract/compute-budgets.md)
- [`contract/storage.md`](../contract/storage.md)
- [`admin-api.md`](admin-api.md)
- [`ws-subprotocol.md`](ws-subprotocol.md)
- [`event-schema.md`](event-schema.md)
- [`subsystems/api-gateway.md`](../subsystems/api-gateway.md)
- [`subsystems/parent-actor.md`](../subsystems/parent-actor.md)
- [`subsystems/control-plane-admin-api.md`](../subsystems/control-plane-admin-api.md)
