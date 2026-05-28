# Substrate contract specification

This is the formal spec implemented by the runtime, SDK, API gateway, control
plane, and scenario-runner. It is intentionally limited to substrate behavior.
There are no billing, balance, debit, refund, reservation, inventory, or
spectator primitives in this spec.

## Version axes

| Axis | Boundary | Mechanism |
|---|---|---|
| Bundle/runtime IPC | Parent actor to child runner | `runtimeContractRequired` checked against shard `runtimeContractsSupported`. |
| Gateway/URL service HTTP | API gateway to operator service | `X-Gateway-Envelope-Version: 2`. |
| Bundle/application service | Creator code to URL service | Versioned kind names such as `mock-ai.v1`. |

There is no fourth version axis. Channel payloads are governed by the runtime
contract version and are not individually versioned.

## Bundle manifest

```ts
interface BundleManifest {
  compatTagProduced: string;
  compatTagsAccepted: readonly string[];
  runtimeContractRequired: number;
}
```

Validation rules:

- `compatTagProduced` is a non-empty string.
- `compatTagsAccepted` is a non-empty string array.
- `compatTagsAccepted` includes `compatTagProduced`.
- `runtimeContractRequired` is a positive integer.

Enforcement gates:

| Gate | Rule | Failure |
|---|---|---|
| Flip gate | `game.blobCompatTag in newBundle.compatTagsAccepted` | `409 compatTagOutOfRange` with `blobCompatTag` and accepted tags. |
| Cold-wake gate | Same check before waking an existing game on a bundle. | Wake refused and history records `bundle.coldWake.rejected`. |
| Placement gate | `bundle.runtimeContractRequired in shard.runtimeContractsSupported` | Placement refused with `contractOutOfRange`. |

Successful bundle flips persist a seven-day rollback backup on the game record:
`{ previousBundleName, failedBundleName, createdAt, expiresAt,
consecutiveWakeFailures }`. If `onWake` fails repeatedly on the new bundle,
the parent records `onWake.failed`, increments the consecutive failure count,
and emits `bundle.rollback.thresholdReached` when the configured threshold is
met. A completed rollback writes the previous bundle name back to the game
record, clears the backup metadata, emits `bundle.rollback`, and restarts the
child on the previous bundle.

## Lifecycle payloads

| Payload | Required fields |
|---|---|
| `OnWakePayload` | `reason`, `runId`, `bundleName`, `bundleCompatTag`; optional `blobCompatTag`, `state`, `blob`. |
| `OnSleepPayload` | `deadline`, `reason`. |
| `OnPlayerConnectPayload` | `playerId`, `sessionId`, `jwtClaims`, `connectedAt`. |
| `OnPlayerDisconnectPayload` | `playerId`, `sessionId`, `reason`. |
| `OnPlayerMessagePayload` | `playerId`, `sessionId`, `seq`, `body`. |
| `OnCapacityWarningPayload` | `budget`, `currentUsage`, `limit`. |

Wake reasons are `cold-start`, `reconnect`, `cold-restart-after-crash`,
`cold-restart-after-eviction`, `cold-restart-after-shard-loss`, and
`upgrade`.

Disconnect reasons are `left`, `timedOut`, `removedFromAllowedPlayers`,
`shardEvicted`, and `gameDeleted`.

## Creator context

The SDK type `SubstrateContext` is authoritative. The child runner injects:

| Surface | Methods |
|---|---|
| Determinism | `rng()`, `now()` |
| Websocket | `ws.send(target, body)` |
| Observability | `log.emit(payload)`, `metrics.emit(payload)`, `console.*` proxy |
| Lifecycle | `lifecycle.requestSleep()` |
| URL services | `api.invoke(kind, args, options?)` |
| Session views | `players.allowed()`, `players.connected()` |
| Compute views | `compute.budget()` |
| State tier | `state.read()`, `state.write(value)`, `state.flush()` |
| Blob tier | `blob.read()`, `blob.write(value)` |

In scenario/test mode, the runner passes the scenario manifest seed through
`PAX_TEST_SEED`. The parent uses a shard-namespaced derivation of that seed for
platform run/session id generation and includes the original seed as bootstrap
`testSeed`; child runners derive creator-visible `c.rng()` and `c.now()` from
the same seed.

Websocket send responses are `{ ok: true, sent, bytes }` or `{ ok: false,
error: "bandwidthExceeded" | "rateExceeded" | "serializationFailed", detail? }`.
The child runner returns `serializationFailed` before IPC if `target` or `body`
cannot be represented as JSON, and still emits `ws.send.rejected` history for
that local rejection.

Storage write responses are `{ ok: true }` or `{ ok: false, error:
"sizeExceeded" | "storageUnavailable", detail? }`.

Console proxy records use `log.emit` with `event: "console"`,
`source: "console"`, a severity `level`, a string `message`, and normalized
`args`.

## API gateway envelope

`c.api.invoke` sends an HTTP request body:

```ts
interface GatewayHttpRequestBody {
  args: unknown;
  context: {
    gameId: string;
    triggeringSessionId: string | null;
    triggeringJwtClaims: Record<string, unknown> | null;
    connectedSessions: readonly ConnectedSessionSnapshot[];
    bundleName: string;
    bundleCompatTag: string;
    runId: string;
    traceId: string | null;
    idempotencyKey: string | null;
  };
}
```

The gateway adds `X-Gateway-Envelope-Version: 2`. URL services respond with
`{ result }` or `{ error, detail? }`. The substrate maps substrate-owned
failures to `kindUnknown`, `providerError`, `apiRateExceeded`, or
`replayCoverageGap` and records both request and response at wire grain.
Replay fixture records are keyed by the same outbound fingerprint and contain
the recorded status code plus raw inbound payload; missing fixture coverage
must surface as `replayCoverageGap`.
The parent history stream records this as `api.invoke.wire` with the
gateway request id, fingerprint, mode, status code, raw outbound payload,
and raw inbound payload.

## Compute budgets

The canonical budget names are:

- `cpu-ms-per-tick`
- `memory-bytes`
- `bandwidth-bytes-per-sec`
- `ws-messages-per-sec`
- `state-bytes`
- `blob-bytes`
- `api-invocations-per-min`

The runtime emits budget history and capacity warnings, exposes snapshots via
`c.compute.budget()`, and enforces per-budget failure behavior described in
[compute-budgets-catalog.md](compute-budgets-catalog.md).

Unexpected child exits are recorded as `child.exit` with `intentional: false`,
followed by `child.restart` scoped to the same actor/game. The restart sends
the next `onWake` with `reason: "cold-restart-after-crash"` and rehydrates from
the persisted state/blob tiers. Intentional stops after `onSleep` are recorded
with `intentional: true` and do not restart the child.

Handler budget failures are recorded as `child.handlerError` with
`code: "handlerTimeout"`, `durationMs`, and `timeoutMs`, plus a paired
`compute.budget.rejected` event for `cpu-ms-per-tick`.
Successful handlers record `child.handlerComplete` with `durationMs` so
`c.compute.budget()` reflects the last observed handler cost. The parent
passes the configured `cpu-ms-per-tick` limit to each child runner during
bootstrap as `handlerTimeoutMs`; the child uses that value for bundle eval,
handler execution, and timeout telemetry.

## History contract

History is JSONL with at least `event`, ISO `ts`, `shardId`, and a positive
per-shard monotonic `pax_seq`. Session-originated events also carry the
placement `traceId`, and API invokes propagate it through the gateway context
and W3C `traceparent` header. Events that name a game, actor, request, player,
or session include the corresponding ids.
Guarantee #14 validates that channel calls, lifecycle transitions, session
transitions, storage operations, API wire records, bundle gates, placement
decisions, rollback decisions, and compute events are observable.

Scenario-runner replay treats incomplete history as a blocking substrate
failure because the remaining oracles are uninterpretable without it.

## Oracle map

| # | Guarantee | Oracle file |
|---|---|---|
| 1 | Singleton game | `singleton-game.mts` |
| 2 | Allowed-only connection | `allowed-only-connection.mts` |
| 3 | Unique stable session id | `unique-stable-sessionid.mts` |
| 4 | Session observability accuracy | `session-observability-accuracy.mts` |
| 5 | Faithful API dispatch | `faithful-api-dispatch.mts` |
| 6 | Idempotent player input | `idempotent-player-input.mts` |
| 7 | Compute-plane quotas honored | `compute-plane-quotas.mts` |
| 8 | Crash blast radius = 1 game | `crash-blast-radius.mts` |
| 9 | No random parent crashes | `no-random-parent-crashes.mts` |
| 10 | Eviction minimum budget | `eviction-minimum-budget.mts` |
| 11 | State durability | `state-durability.mts` |
| 12 | Blob durability | `blob-durability.mts` |
| 13 | Migration rollback safety | `migration-rollback-safety.mts` |
| 14 | History completeness | `history-completeness.mts` |
| 15 | Bundle compatibility safety | `bundle-compatibility-safety.mts` |
| 16 | Placement contract safety | `placement-contract-safety.mts` |

The canonical index is `testing/oracles-lib/src/guarantees/index.mts`.
