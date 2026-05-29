# History event schema

> Layer: **Reference catalog**

Every event the substrate emits, with required fields. Oracles read
against this catalog; any drift is a substrate bug.

The conceptual surface for history events lives in
[`contract/history-events.md`](../contract/history-events.md); this page
is the exhaustive name-and-fields list.

## Required fields on every event

Every event carries at minimum:

| Field | Type | Notes |
|---|---|---|
| `event` | string | Event name (one of the names below) |
| `ts` | string (ISO 8601 with ns precision) | When observed |
| `shardId` | string | Which shard emitted (or `"control"`, `"router"`, `"gateway"` for orchestration-emitted events) |
| `pax_seq` | positive integer | Monotonic per shard, gap-free across restart |

## Lifecycle events

### `onWake.sent`

Broker → isolate. Bundle receives `onWake`.

| Field | Notes |
|---|---|
| `gameId` | |
| `bundleName` | |
| `bundleCompatTag` | |
| `blobCompatTag?` | undefined on cold-start |
| `wakeReason` | one of `cold-start`, `reconnect`, `cold-restart-after-crash`, `cold-restart-after-eviction`, `cold-restart-from-storage`, `upgrade` |
| `errorClass?` | present on `cold-restart-after-crash` |
| `runId` | |

### `onWake.succeeded`

Bundle's `onWake` handler returned without error.

| Field | Notes |
|---|---|
| `gameId` | |
| `durationMs` | |

### `onWake.failed`

Bundle's `onWake` threw or timed out.

| Field | Notes |
|---|---|
| `gameId` | |
| `durationMs` | |
| `errorClass` | `'exception' \| 'handlerTimeout'` |
| `message?` | error message |

### `onSleep.sent`

Broker → isolate. Bundle receives `onSleep`.

| Field | Notes |
|---|---|
| `gameId` | |
| `reason` | `'idle' \| 'requestedBySleep' \| 'evicted' \| 'shardEvicted' \| 'shutdown' \| 'upgrade'` |
| `deadline` | ms since epoch |
| `budgetMs` | grace window from now |

### `onSleep.deadline`

Bundle did not report `lifecycle.sleepComplete` before the deadline.

| Field | Notes |
|---|---|
| `gameId` | |
| `reason` | sleep reason |
| `deadline` | ms since epoch |

### `lifecycle.sleepComplete`

Bundle signaled it is done with `onSleep`; the Broker then checkpointed
state and released the active game.

| Field | Notes |
|---|---|
| `gameId` | |
| `reason` | sleep reason |
| `deadline` | ms since epoch |
| `bundleName` | |
| `blobCompatTag` | after the planned-transition checkpoint |

### `lifecycle.sleepGrace.started`

The last player disconnected and the Broker started the idle grace timer.

| Field | Notes |
|---|---|
| `gameId` | |
| `delayMs` | configured grace duration |
| `deadline` | ms since epoch |

### `lifecycle.sleepGrace.cancelled`

A reconnect, explicit sleep, or release cancelled the pending idle grace.

| Field | Notes |
|---|---|
| `gameId` | |
| `cause` | cancellation source |

### `lifecycle.sleepGrace.expired`

The idle grace expired with no connected sessions; the Broker will send
`onSleep` with `reason: 'idle'`.

| Field | Notes |
|---|---|
| `gameId` | |
| `deadline` | ms since epoch |

### `game.released`

The Broker released the game from the active-game directory after a
planned sleep transition.

| Field | Notes |
|---|---|
| `gameId` | |
| `reason` | sleep reason |

### `broker.start`

A Broker process started on a shard. Shard-scoped (no `gameId`).

| Field | Notes |
|---|---|
| `version` | |
| `runtimeContractsSupported` | |

### `broker.stop`

A Broker process is stopping. Shard-scoped.

| Field | Notes |
|---|---|
| `intentional` | bool |
| `reason?` | |

### `isolate.created`

A game's isolate was created and its bundle eval'd (wake).

| Field | Notes |
|---|---|
| `gameId` | |
| `bundleName` | |
| `runtimeContractRequired` | |
| `runnerName` | which Runner hosts it |

### `isolate.disposed`

A game's isolate was disposed (sleep, eviction, or after a fatal error).

| Field | Notes |
|---|---|
| `gameId` | |
| `intentional` | bool |
| `reason?` | |

### `runner.crash`

A Runner process died (native crash / segfault), taking its co-tenant
isolates with it. Runner-scoped.

| Field | Notes |
|---|---|
| `runnerId` | |
| `affectedGameIds` | array (bounded by `K`) |
| `maxAssignedGames` | configured `K` bound for this Runner slot |
| `code?` | process exit code, if any |
| `signal?` | |

### `isolate.restart`

The Broker re-created an isolate after an unexpected disposal (per-isolate
crash) or a `runner.crash`.

| Field | Notes |
|---|---|
| `gameId` | |
| `runnerId` | replacement Runner |
| `previousRunnerId?` | Runner that crashed, when cause is `runnerCrash` |
| `cause` | `'oom' \| 'crash' \| 'cpuTimeout' \| 'runnerCrash' \| 'unknown'` |

### `isolate.restart.failed`

The Broker gave up restarting after repeated failures.

### `isolate.fatal`

A game's isolate hit a fatal error (before disposal).

| Field | Notes |
|---|---|
| `gameId` | |
| `message` | |

### `handler.complete`

A bundle handler returned without error.

| Field | Notes |
|---|---|
| `gameId` | |
| `handlerName` | `'onWake' \| 'onSleep' \| 'onPlayerConnect' \| ...` |
| `durationMs` | |

### `handler.error`

A bundle handler threw or timed out.

| Field | Notes |
|---|---|
| `gameId` | |
| `handlerName` | |
| `durationMs` | |
| `code` | `'handlerTimeout' \| 'handlerException'` |
| `timeoutMs?` | for `handlerTimeout` |
| `message?` | for `handlerException` |

### `onCapacityWarning.sent`

Broker → isolate. Best-effort budget warning.

| Field | Notes |
|---|---|
| `gameId` | |
| `budget` | one of the 8 compute budgets |
| `currentUsage` | |
| `limit` | |

### `onHostEvent.received`

Control plane received a `POST /admin/games/:id/host-event`.

| Field | Notes |
|---|---|
| `gameId` | |
| `eventType` | |
| `wakeOnDelivery` | bool |

### `onHostEvent.delivered`

Broker → isolate. The bundle's `onHostEvent` was called.

| Field | Notes |
|---|---|
| `gameId` | |
| `eventType` | |
| `deliveryAttempts` | int (≥1 for at-least-once) |

## Session events

### `session.opened`

WS connection accepted.

| Field | Notes |
|---|---|
| `gameId` | |
| `sessionId` | |
| `playerId` | |
| `connectedAt` | ISO |
| `traceId?` | from JWT |

### `session.closed`

WS connection closed.

| Field | Notes |
|---|---|
| `gameId` | |
| `sessionId` | |
| `playerId` | |
| `connectedAt` | ISO |
| `disconnectedAt` | ISO |
| `reason` | `'left' \| 'timedOut' \| 'removedFromAllowedPlayers' \| 'shardEvicted' \| 'gameDeleted'` |

### `session.forceDisconnect`

Substrate proactively disconnected a session (typically from
`removeAllowedPlayer`).

| Field | Notes |
|---|---|
| `gameId` | |
| `sessionId` | |
| `playerId` | |
| `cause` | `'allowedPlayersRemoval' \| 'shardEvicted' \| 'gameDeleted'` |

### `connection.refused`

WS handshake refused.

| Field | Notes |
|---|---|
| `gameId?` | target game, when the Broker has enough context |
| `playerId?` | from JWT, if parseable |
| `reason` | `'notAllowed' \| 'wrongGame' \| 'wrongShard' \| 'gameDeleted'` |

### `connection.replay`

Fly WS upgrade request landed on a non-target Broker, which returned
`Fly-Replay` before negotiating the upgrade.

| Field | Notes |
|---|---|
| `gameId` | |
| `playerId` | |
| `tokenShardId` | target shard from the placement JWT |
| `flyMachineId` | target Fly machine id used in the replay header |

## Player I/O events

### `onPlayerMessage`

Broker → isolate. Player message dispatched.

| Field | Notes |
|---|---|
| `gameId` | |
| `sessionId` | |
| `playerId` | |
| `seq` | per-session monotonic |
| `body` | the message |

### `ws.send`

Bundle → client. Substrate dispatched an outbound WS message.

| Field | Notes |
|---|---|
| `gameId` | |
| `target` | `'all' \| string \| string[]` |
| `sessionId?` | present when exactly one open recipient was sent |
| `playerId?` | present when exactly one open recipient was sent |
| `recipientCount` | number sent |
| `bytes` | total bytes sent |

### `ws.send.rejected`

Bundle's `c.ws.send` rejected by substrate.

| Field | Notes |
|---|---|
| `gameId` | |
| `target` | |
| `error` | `'bandwidthExceeded' \| 'rateExceeded' \| 'serializationFailed' \| 'targetInvalid' \| 'targetNotConnected'` |

## Storage events

### `state.read`, `state.write`, `state.flush`

State object operations (cache-level; `state.flush` requests an immediate
checkpoint).

| Field | Notes |
|---|---|
| `gameId` | |
| `byteSize` | for write |

### `state.checkpoint`

A game was atomically committed to Tigris (the root PUT). A clean game
emits nothing.

| Field | Notes |
|---|---|
| `gameId` | |
| `checkpointSeq` | the new monotonic commit number |
| `codec` | `'whole' \| 'json-delta' \| 'cdc'` |
| `byteSize` | bytes written this checkpoint |
| `trigger` | `'interval' \| 'flush' \| 'sleep'` |
| `durationMs` | |

### `state.restore`

A time-travel restore advanced `head` to reference a prior root
(revert-forward).

| Field | Notes |
|---|---|
| `gameId` | |
| `fromCheckpointSeq` | the root restored to |
| `newCheckpointSeq` | the new head |

### `state.write.rejected`

Substrate rejected a `c.state.write`.

| Field | Notes |
|---|---|
| `gameId` | |
| `error` | `'sizeExceeded' \| 'storageUnavailable'` |

### `blob.put`, `blob.get`, `blob.delete`, `blob.list`

Blob namespace operations.

| Field | Notes |
|---|---|
| `gameId` | |
| `key?` | for put/get/delete |
| `prefix?` | for list |
| `byteSize?` | for put |
| `keyCount?` | for list response |

### `blob.put.rejected`

| Field | Notes |
|---|---|
| `gameId` | |
| `key` | |
| `error` | `'sizeExceeded' \| 'keyCountExceeded' \| 'storageUnavailable'` |

## API events

### `api.invoke.request`

Broker received a `c.api.invoke` from a Runner (on behalf of its isolate).

| Field | Notes |
|---|---|
| `gameId` | |
| `sessionId?` | triggering session (null for lifecycle-triggered) |
| `kind` | |
| `requestId` | UUID |
| `idempotencyKey?` | |

### `api.invoke.response`

Broker returned the response to the Runner.

| Field | Notes |
|---|---|
| `gameId` | |
| `requestId` | |
| `ok` | bool |
| `error?` | substrate-owned error code |
| `durationMs` | |

### `api.invoke.wire`

Wire-grain record (gateway-side; carries the full envelopes).

| Field | Notes |
|---|---|
| `gameId` | |
| `requestId` | |
| `kind` | |
| `mode` | `'live' \| 'replay'` |
| `fingerprint` | sha256 |
| `statusCode` | |
| `durationMs` | |
| `rawOutbound` | serialized full envelope sent to URL service |
| `rawInbound` | serialized full response from URL service |
| `traceId?` | |

## Compute events

### `compute.budget`

Substrate snapshot of compute budgets (emitted on warning or periodically).

| Field | Notes |
|---|---|
| `gameId` | |
| `snapshot` | the full `ComputeBudgetSnapshot` shape |

### `compute.budget.rejected`

A budget enforcement fired.

| Field | Notes |
|---|---|
| `gameId` | |
| `budget` | which of the 8 |
| `used` | |
| `limit` | |

## Bundle events

### `bundle.uploaded`

`POST /admin/bundles/:bundleName` succeeded.

| Field | Notes |
|---|---|
| `bundleName` | |
| `contentSha256` | |
| `sizeBytes` | |
| `manifest` | full manifest |

### `bundle.loaded`

A Runner eval'd a bundle into a game's isolate.

| Field | Notes |
|---|---|
| `gameId` | |
| `bundleName` | |
| `contentSha256` | |
| `durationMs` | bundle eval time |

### `bundle.loaded.failed`

Bundle source failed to parse or eval.

| Field | Notes |
|---|---|
| `gameId` | |
| `bundleName` | |
| `cause` | `'parseError' \| 'manifestInvalid' \| 'evalError'` |
| `message` | |

### `bundle.flip.succeeded`

Bundle pointer flipped.

| Field | Notes |
|---|---|
| `gameId` | |
| `previousBundleName` | |
| `newBundleName` | |
| `blobCompatTag?` | the game's tag at flip time |

### `bundle.flip.refused`

| Field | Notes |
|---|---|
| `gameId` | |
| `attemptedBundleName` | |
| `reason` | `'compatTagOutOfRange'` |
| `blobCompatTag` | |
| `bundleCompatTagsAccepted` | |

### `bundle.coldWake.rejected`

Shard refused to load a bundle on cold wake (defense-in-depth gate).

| Field | Notes |
|---|---|
| `gameId` | |
| `bundleName` | |
| `reason` | |
| `blobCompatTag?` | |
| `bundleCompatTagsAccepted?` | |

### `bundle.rollback.thresholdReached`

N consecutive `onWake.failed` for a flipped bundle.

| Field | Notes |
|---|---|
| `gameId` | |
| `failedBundleName` | |
| `consecutiveFailures` | |

### `bundle.rollback`

Control plane rolled back to the previous bundle.

| Field | Notes |
|---|---|
| `gameId` | |
| `failedBundleName` | |
| `restoredBundleName` | |

### `bundle.deleted`

`DELETE /admin/bundles/:bundleName`.

| Field | Notes |
|---|---|
| `bundleName` | |

## Topology events

### `placement.accepted`

Router signed a placement token and returned `webSocketUrl`.

| Field | Notes |
|---|---|
| `gameId` | |
| `playerId` | |
| `shardId` | |
| `bundleName` | |
| `runtimeContractRequired` | |
| `runtimeContractsSupported` | the chosen shard's range |
| `traceId?` | |

### `placement.refused`

| Field | Notes |
|---|---|
| `gameId` | |
| `playerId` | |
| `reason` | `'contractOutOfRange' \| 'noEligibleShards' \| 'gameNotFound' \| 'directoryUnavailable'` |

### `game.created`

`POST /admin/games`.

| Field | Notes |
|---|---|
| `gameId` | |
| `bundleName` | |
| `allowedPlayerCount` | |

### `game.deleted`

`DELETE /admin/games/:id`.

### `player.deleted`

`DELETE /admin/players/:playerId`.

| Field | Notes |
|---|---|
| `playerId` | |
| `affectedGameIds` | array |

### `allowed-players.added`, `allowed-players.removed`

| Field | Notes |
|---|---|
| `gameId` | |
| `playerId` | |

### `shard.registered`

Shard started up and announced.

| Field | Notes |
|---|---|
| `shardId` | |
| `version` | |
| `runtimeContractsSupported` | |

### `shard.drain.started`, `shard.drain.completed`

| Field | Notes |
|---|---|
| `shardId` | |

## Bundle-emitted events (passthrough)

### `log.emit`

The bundle's `c.log.emit` calls (including console proxy).

| Field | Notes |
|---|---|
| `gameId` | |
| `source` | `'creator' \| 'console'` |
| `level` | `'debug' \| 'info' \| 'warn' \| 'error'` |
| `payload` | verbatim from the bundle |

### `metrics.emit`

The bundle's `c.metrics.emit` calls.

| Field | Notes |
|---|---|
| `gameId` | |
| `name` | bundle-defined metric name (prefix `pax_creator_*`) |
| `kind` | `'counter' \| 'gauge' \| 'histogram'` |
| `value` | |
| `labels?` | |

## Cross-references

- [`contract/history-events.md`](../contract/history-events.md) — conceptual surface
- [`subsystems/broker.md`](../subsystems/broker.md) — most events emitted here
- [`subsystems/control-plane-admin-api.md`](../subsystems/control-plane-admin-api.md) — control-plane-emitted events
- [`subsystems/scenario-runner.md`](../subsystems/scenario-runner.md) — oracles read these
- [`vision/guarantees.md`](../vision/guarantees.md) #14 (history completeness)
- [`error-codes.md`](error-codes.md) — error code values referenced in events
