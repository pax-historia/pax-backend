# The substrate contract for creators

This is the creator-facing contract exposed by `@pax-backend/runtime-sdk`.
The substrate runs one creator bundle per game, calls its lifecycle handlers,
and injects a typed context object named `c`.

The substrate deliberately stays small. It provides session transport,
storage, compute-plane limits, observability, and one external API channel.
It does not provide billing, balances, debits, reservations, refunds, AI token
accounting, item inventories, moderation policy, or spectator policy. Those
are operator-owned application concerns implemented behind URL services.

## Bundle shape

A bundle exports `defineBundle({ manifest, ...handlers })`.

The manifest is:

| Field | Meaning |
|---|---|
| `compatTagProduced: string` | Opaque blob-shape tag written after a successful `onSleep`. |
| `compatTagsAccepted: string[]` | Set of blob tags this bundle can read on `onWake`. Must include `compatTagProduced`. |
| `runtimeContractRequired: number` | Minimum substrate IPC contract version required by this bundle. |

Tags are opaque strings. The substrate enforces set membership only; operators
own naming conventions such as `game:v1`, `game:v2-bridge`, or content hashes.
See [bundle-compatibility.md](bundle-compatibility.md).

## Lifecycle

Handlers are optional and may return a promise:

| Handler | When called |
|---|---|
| `onWake(c, payload)` | The game starts, restarts, reconnects, migrates, or upgrades. Payload includes `reason`, `runId`, bundle name/tag, and optional state/blob snapshots. |
| `onSleep(c, payload)` | The substrate is giving the bundle a bounded flush window before sleep, shutdown, eviction, or upgrade. |
| `onPlayerConnect(c, payload)` | A whitelisted player connects. Payload includes `playerId`, stable `sessionId`, JWT claims, and `connectedAt`. |
| `onPlayerDisconnect(c, payload)` | A connected session leaves or is forcibly removed. |
| `onPlayerMessage(c, payload)` | A player sends a message. The substrate supplies a per-session `seq` and never delivers the same `(playerId, seq)` twice. |
| `onCapacityWarning(c, payload)` | A compute budget is approaching its limit. |

`sessionId` is substrate-generated, opaque, cluster-unique, and stable for the
connection lifetime. It is the same id seen in lifecycle payloads, API gateway
context, admin session views, and history.

## Context surface

| API | Contract |
|---|---|
| `c.rng()` | Deterministic PRNG in test mode. |
| `c.now()` | Deterministic substrate clock in test mode. |
| `c.ws.send(target, body)` | Sends JSON-safe data to `"all"`, one player, or selected players; resolves to `{ ok: true, sent, bytes }` or a typed WS quota error. |
| `c.log.emit(payload)` | Emits structured history/log data with bundle/game metadata. |
| `c.metrics.emit(payload)` | Emits numeric metrics for runtime and scenario attribution. |
| `c.lifecycle.requestSleep()` | Voluntary sleep request; the substrate may later call `onSleep`. |
| `c.api.invoke(kind, args, options?)` | Calls an operator-registered URL service by kind and returns the response verbatim or a typed substrate error. |
| `c.players.allowed()` | Reads the substrate-owned per-game whitelist. |
| `c.players.connected()` | Reads the live connected-session snapshot. |
| `c.compute.budget()` | Reads current compute-plane usage and configured limits. |
| `c.state.read/write/flush()` | Small, fast per-game state tier. Same-shard durable modulo throttle. |
| `c.blob.read/write()` | Large global durable blob tier. Survives shard loss and deploys. |

## External API channel

Bundles call `c.api.invoke("kind.name", args)`. The substrate:

1. Looks up `kind.name` in the operator's URL-kind registry.
2. Checks the per-game `api-invocations-per-min` budget.
3. Builds the gateway context envelope with game id, triggering session id and
   claims, connected sessions, bundle name/tag, run id, trace id, and
   idempotency key.
4. Sends an HTTP request with `X-Gateway-Envelope-Version: 2`.
5. Records the wire-grain request/response in history.
6. Returns the URL service result verbatim, or a typed substrate error:
   `kindUnknown`, `providerError`, `apiRateExceeded`, or `replayCoverageGap`.

The substrate does not inspect the business meaning of `args` or `result`.
Billing-like behavior belongs in URL services; the optional
`examples/url-services/billing-mock.v1/` service is documentation and harness
input, not a platform primitive. See [../why/why-no-billing.md](../why/why-no-billing.md).

## Compute budgets

The substrate enforces seven compute-plane budgets per game:

- `cpu-ms-per-tick`
- `memory-bytes`
- `bandwidth-bytes-per-sec`
- `ws-messages-per-sec`
- `state-bytes`
- `blob-bytes`
- `api-invocations-per-min`

Over-budget behavior is typed: a call is rejected, a handler timeout is
recorded, or a child is killed and restarted depending on the budget. See
[compute-budgets-catalog.md](compute-budgets-catalog.md).

## Guarantees

The runtime and scenario-runner own the 16 Strong Platform Guarantees from
the README: singleton game, allowed-only connection, stable session ids,
session observability, faithful API dispatch, idempotent input, compute
quotas, crash isolation, parent stability, eviction budget, state durability,
blob durability, rollback safety, complete history, bundle compatibility, and
placement contract safety.

The guarantees are substrate guarantees only. If a bundle can violate one,
the platform has a bug. Operator policy correctness remains outside this
contract and should be tested against operator URL services.
