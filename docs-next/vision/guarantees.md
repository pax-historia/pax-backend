# Strong platform guarantees

> Layer: **Vision**

These are the seventeen properties the substrate commits to. Each one is
testable from history alone. Each one has a corresponding oracle in the
scenario-runner's first-party library
([`subsystems/scenario-runner.md`](../subsystems/scenario-runner.md)). A
guarantee failure in CI is a release blocker.

None of these mention billing, balances, debits, or whether a player
"should have been allowed" to pay for something. Those are URL service and
vercel backend properties — they live in operator-side test suites against
the URL services.

## The seventeen

| # | Name | The promise | Oracle |
|---|---|---|---|
| **1** | Singleton game | Exactly one running child per `gameId` at a time, anywhere on the cluster | `singleton-game.mts` |
| **2** | Allowed-only connection | Substrate refuses any WS connect for a player not in `allowedPlayers(gameId)`, regardless of JWT validity. Removing a player force-disconnects any active session they have on that game | `allowed-only-connection.mts` |
| **3** | Unique, stable `sessionId` | Every WS connection gets a cluster-wide-unique `sessionId`, stable for the connection's lifetime, opaque, unforgeable, and matching across `onPlayerConnect` / `onPlayerMessage` / `onPlayerDisconnect`, every `api.invoke` `triggeringSessionId`, and every `session.opened` / `session.closed` history event | `unique-stable-sessionid.mts` |
| **4** | Session observability accuracy | The `connectedSessions` snapshot in every `api.invoke` context envelope, the `GET /admin/games/:id/connected-players` response, and the live session history events all reflect the substrate's actual connection state at the moment of observation | `session-observability-accuracy.mts` |
| **5** | Faithful API dispatch and recording | Every `api.invoke` either (a) dispatches with the library-defined envelope and returns the response verbatim, OR (b) fails with a typed error naming which substrate check refused (`kindUnknown`, `apiRateExceeded`, `providerError`, `replayCoverageGap`). In either case the round trip is recorded at wire grain | `faithful-api-dispatch.mts` |
| **6** | Idempotent player input | No `(playerId, seq)` is ever delivered to the child twice. If the child is restarting, the platform replays at most once and never duplicates | `idempotent-player-input.mts` |
| **7** | Compute-plane quotas honored | Each of the eight enumerated compute budgets is enforced per game: `cpu-ms-per-tick`, `memory-bytes`, `bandwidth-bytes-per-sec`, `ws-messages-per-sec`, `state-bytes`, `blob-bytes`, `blob-keys`, `api-invocations-per-min`. Over-quota means typed error or child kill per the budget's kind. No silent degradation | `compute-plane-quotas.mts` |
| **8** | Crash blast radius = 1 game | A child crash, OOM, or CPU timeout affects only that game | `crash-blast-radius.mts` |
| **9** | No random parent crashes | Parent actor process death without `onSleep` is a platform bug and is alerted/post-mortemed. Bundles don't need to defensively code around this | `no-random-parent-crashes.mts` |
| **10** | Eviction minimum budget | `onSleep` always gives the bundle at least the documented per-shape minimum to flush | `eviction-minimum-budget.mts` |
| **11** | `c.state` flush-window durability | Tigris is the canonical store. On planned sleep / drain / cross-shard migration, the substrate flushes all pending writes before releasing the game — **zero loss on planned transitions**. On unplanned process or machine death, at most the configured flush window of writes is lost; recovery surfaces `cold-restart-from-storage`. Same-shard restart resumes from the same canonical object | `state-durability.mts` |
| **12** | `c.blob` namespace survives everything | Every `put` is durable on resolve. The per-game namespace at `blob/<gameId>/` survives cross-shard, cross-deploy, and cross-volume-loss. Substrate-side operations (snapshot, delete-game) treat the namespace as a unit; deletion clears all keys | `blob-durability.mts` |
| **13** | Migration rollback safety | Buggy `onWake` on a new bundle version rolls back to the previous version after N consecutive failures; 7-day backup retention | `migration-rollback-safety.mts` |
| **14** | History is complete | Every channel call, every lifecycle event, every session transition, every shard event, every `api.invoke` wire round trip, every bundle gate decision, every placement decision, every rollback decision, every compute event is recorded to a structured history that tests and the vercel backend can read | `history-completeness.mts` |
| **15** | Bundle compatibility safety | The substrate refuses any bundle-pointer flip or cold wake where the game's `blobCompatTag ∉ newBundle.compatTagsAccepted`. No game ever wakes on a bundle whose `onWake` cannot read the blob it is being handed. Flip refusals return `409 compatTagOutOfRange` with `{ blobCompatTag, bundleCompatTagsAccepted }` so vercel backend tooling can plan a bridge | `bundle-compatibility-safety.mts` |
| **16** | Placement contract safety | The placement router refuses to route a game onto a shard whose `runtimeContractsSupported` range does not include the game's `bundle.runtimeContractRequired`. No shard ever loads a bundle that calls a hook or channel it does not implement, and no rolling shard upgrade can accidentally place a new-only bundle onto an old shard mid-deploy | `placement-contract-safety.mts` |
| **17** | Host-event durability | A `POST /admin/games/:id/host-event` with `wakeOnDelivery: true` is delivered at least once to the bundle's `onHostEvent` handler within TTL of the POST, including across game hibernation. The substrate persists the event, wakes the game if asleep, delivers, and emits a `onHostEvent.delivered` history event. Bundle code MUST be idempotent on `eventType + payload` | `host-event-durability.mts` |

## What's NOT in this list

Compare to URL-service-side properties — these are the operator's
responsibility and live in their test suite, not in the substrate's release
gate:

- Balance arithmetic correctness
- Refund integrity
- Hot-row throughput on the ledger
- Top-up event consistency
- Regulatory event emission
- "Spectator caps work" / role enforcement correctness
- AI cost-spike detection
- Anti-fraud heuristics

Those properties are real and important. They're not the substrate's job.

## Implications for the test pipeline

- Every guarantee is a single-file oracle in `testing/oracles-lib/src/guarantees/`.
- The scenario-runner runs every oracle by default on every scenario; an
  oracle failure on **any** scenario fails CI.
- The smoke-bot vertical test is M0 only — the actual release gate is the
  16+1 oracle suite on the canonical scenarios (`chat-steady-state`,
  `compute-stress`, `shard-death-resilience`) plus per-bundle oracles for
  bundle-correctness properties.

See [`subsystems/scenario-runner.md`](../subsystems/scenario-runner.md) for
mechanics.

## What happens when a guarantee can't hold

If implementation evidence ever surfaces that one of these can't be honored
at scale, **the guarantee gets weakened explicitly** with a new oracle that
asserts the weaker property and a new `why/` doc explaining the trade-off.
The substrate doesn't silently degrade — it tells the truth in its contract.
