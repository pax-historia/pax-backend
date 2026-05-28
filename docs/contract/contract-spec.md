# Substrate contract specification

This is the formal spec implemented by the runtime, SDK, API gateway, control
plane, and scenario-runner. It is intentionally limited to substrate behavior.
There are no billing, balance, debit, refund, reservation, inventory, or
spectator primitives in this spec.

## Version axes

| Axis | Boundary | Mechanism |
|---|---|---|
| Bundle/runtime IPC | Parent actor to child runner | `runtimeContractRequired` checked against shard `runtimeContractsSupported`. |
| Gateway/URL service HTTP | API gateway to operator service | `X-Gateway-Envelope-Version: 1`. |
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
| Observability | `log.emit(payload)`, `metrics.emit(payload)` |
| Lifecycle | `lifecycle.requestSleep()` |
| URL services | `api.invoke(kind, args, options?)` |
| Session views | `players.allowed()`, `players.connected()` |
| Compute views | `compute.budget()` |
| State tier | `state.read()`, `state.write(value)`, `state.flush()` |
| Blob tier | `blob.read()`, `blob.write(value)` |

Storage write responses are `{ ok: true }` or `{ ok: false, error:
"sizeExceeded" | "storageUnavailable", detail? }`.

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
    idempotencyKey: string | null;
  };
}
```

The gateway adds `X-Gateway-Envelope-Version: 1`. URL services respond with
`{ result }` or `{ error, detail? }`. The substrate maps substrate-owned
failures to `kindUnknown`, `providerError`, `apiRateExceeded`, or
`replayCoverageGap` and records both request and response at wire grain.

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

## History contract

History is JSONL with at least `event`, ISO `ts`, and `shardId`. Events that
name a game, actor, request, player, or session include the corresponding ids.
Guarantee #14 validates that channel calls, lifecycle transitions, session
transitions, storage operations, API wire records, bundle gates, placement
decisions, and compute events are observable.

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
