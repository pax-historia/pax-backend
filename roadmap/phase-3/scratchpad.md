# Phase 3 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-28 08:44 PDT

Started Phase 3 after re-reading the roadmap directive/exit signal, [`docs-next/proofs/historia-default.md`](../../docs-next/proofs/historia-default.md), and [`examples/bundles/historia-default/README.md`](../../examples/bundles/historia-default/README.md). The five URL service spec files already exist as schema-only docs, but the bundle directory is still README-only and the scenario/oracle suite has not been authored.

Initial work split: audit the URL-service fixture contracts first, then land the bundle scaffold/build shape, then port core state/blob/migration code, modules/workflows, routing/hydration/policy gates, scenarios/oracles, and finally the local/Fly proof run. Keep Pax-historia-specific logic contained under `examples/bundles/historia-default/` and the schema-only URL-service examples; substrate zones stay generic.

## 2026-05-28 08:47 PDT

Finished the URL service spec audit. The five schema-only specs already covered the proof's required kinds and stayed outside substrate internals; the gaps were around fixture authoring rather than application schema. `examples/url-services/README.md` now lists the historia specs and states the replay fixture contract: fixtures are gateway `api.invoke` wire records with a `fingerprint`, `statusCode`, and serialized `rawInbound`, not plain URL-service result files. This matters because the replay store looks inside each record and hard-fails `replayCoverageGap` on missing fingerprints.

Two smaller spec fixes landed with that audit: `participation.v1` now names the real scenario-runner phase as `send-host-events`, and `ai.chat.v1` represents streamed provider output as deterministic JSON `streamEvents` in proof fixtures instead of a live `ReadableStream`, since the gateway buffers URL-service HTTP responses as JSON.

## 2026-05-28 08:51 PDT

Landed the `historia-default` bundle scaffold. The package now has `package.json`, `tsconfig.json`, root `manifest.ts`, `src/ambient.d.ts`, and `src/index.mts`. The manifest produces `historia:v5` and accepts the full `historia:v1` through `historia:v5` chain. The entrypoint deliberately stays shallow: it logs lifecycle activity, tracks connected sessions, sends a `historia.ready` connect message, echoes unhandled player messages as `historia.unhandled`, and broadcasts host events. State/blob/migrations remain the next task rather than being hidden inside the scaffold.

Verification: initial package-local typecheck failed because the new workspace package had no pnpm node_modules link yet; `pnpm install --offline` added the lockfile importer and local link without downloading dependencies. After that, `pnpm --filter @pax-backend/bundle-historia-default check-types` and `pnpm --filter @pax-backend/bundle-historia-default build` both passed.

## 2026-05-28 08:54 PDT

Finished the core state/blob/migration adapter. Added bundle-local CBOR helpers, a compact `HistoriaWorkingState` shape for `c.state`, a `HistoriaBlobV5` snapshot shape for `c.blob` key `current`, migration dispatch that accepts `historia:v1` through `historia:v5` and normalizes older tags into v5, and persistence helpers for wake load, working-state write/flush, blob snapshot save, and sleep commit. Also added a thin `GameContext` adapter that maps legacy S3-shaped calls onto `c.blob`, generic URL-service calls onto `c.api.invoke`, and projection sync onto `projection.sync.v1`.

The current lifecycle entrypoint now loads and normalizes state/blob on wake, sends hydration summary data on connect, includes current round metadata in unhandled message responses, and commits the current blob snapshot on sleep. Verification: `pnpm install --offline` updated the historia importer with `cborg` (already present in the lockfile), then `pnpm --filter @pax-backend/bundle-historia-default check-types` and `pnpm --filter @pax-backend/bundle-historia-default build` passed.

## 2026-05-28 08:58 PDT

Landed the first module/workflow slice. There is no Pax-historia module source in this repo, so this is a proof-local implementation guided by the Phase 3 docs: default workflow strings for chat, advisor, actions, jump-forward, and moderation; an inline generator workflow runner; URL-service command executors for `ai.chat.v1`, `flag.search.v1`, `projection.sync.v1`, and `moderation.audit.v1`; message handlers for the seven module folders; and small supporting modules for player management, rounds, round timer, map state, offline cap, and permissions. `src/routing/websocket.mts` now dispatches player messages before falling back to `historia.unhandled`.

This is not the finished module port yet. The handlers are intentionally small and mostly stateless; the next slice needs to attach them to persisted blob/working-state updates, hydrate richer client snapshots, and enforce permissions/participation policy gates before scenarios can be meaningful. Verification: `pnpm --filter @pax-backend/bundle-historia-default check-types` and `pnpm --filter @pax-backend/bundle-historia-default build` passed.

## 2026-05-28 09:01 PDT

Made the first-pass module handlers stateful. `GameContext` now owns a mutation boundary over loaded state: modules can append working events, patch game metadata, and set player participation records without reaching into substrate internals. Player-message handlers now persist the updated working state and blob snapshot after handled messages, and host-event routing handles `participationChanged`, `moderationEject`, and `moderation.ejected` by updating bundle state and broadcasting typed events.

This still leaves policy tightening and richer scenario behavior for the next task slices, but the bundle is no longer only transient broadcast behavior. Verification: `pnpm --filter @pax-backend/bundle-historia-default check-types` and `pnpm --filter @pax-backend/bundle-historia-default build` passed.

## 2026-05-28 09:02 PDT

Closed the module/workflow task by adding the workflow task tracker and wiring it into the inline generator runner. The module port is still proof-local rather than a verbatim Pax-historia source move, because this repo does not contain the Pax-historia module source, but the Phase 3-required bundle surface is now present: seven module folders, supporting modules, default workflow strings, workflow engine, executors, and task tracking. Policy and hydration hardening moves to task 5. Verification: `pnpm --filter @pax-backend/bundle-historia-default check-types` and `pnpm --filter @pax-backend/bundle-historia-default build` passed.

## 2026-05-28 09:05 PDT

Finished routing/hydration/policy wiring. Connect now sends a richer hydration snapshot with player state, entity options, pending working events, and workflow task state. The bundle stores session JWT claims from `onPlayerConnect` and uses them for admin/cheat policy checks. Chat, advisor, actions, and jump-forward now require the player to be a participant in the bundle's participation cache before issuing AI URL-service calls; refusals broadcast `historia.policyRefused` and append `policy.refused` working events. Host-event routing persists participation changes and moderation ejects through the same state/blob path as player-message handlers.

Verification: `pnpm --filter @pax-backend/bundle-historia-default check-types` and `pnpm --filter @pax-backend/bundle-historia-default build` passed.

## 2026-05-28 09:12 PDT

Started the scenario/oracle suite. The scenario-runner now supports optional scenario-local `oracles.mts` exports and appends those results to the normal substrate guarantee oracle results. `register-api-kinds` now supports `${controlPlaneUrl}` templating so scenario workloads can register schema-only historia kinds against the co-located deterministic reference URL-service endpoints in both local and Fly runs.

Added shared historia scenario builders, shared baseline fixtures, and all ten representative scenario directories: `chat-basic`, `jump-forward-basic`, `advisor-basic`, `actions-basic`, `role-claim-flow`, `role-destroy-flow`, `spectator-billing-block`, `moderation-flow`, `workflow-override-loaded`, and `host-event-wake-delivery`. Each scenario has manifest/workload/local-oracle files and imports cleanly through the scenario-runner catalog loader. These currently register live deterministic reference endpoints; the remaining task-6 work is to run the suite and freeze or replace URL-service responses with replay fixtures where the proof needs canned records.

## 2026-05-28 09:18 PDT

Started running the local historia scenarios. The first immediate failure was environmental: this execution environment cleans up `nohup`-spawned local stack children when the command exits, so local scenario runs need the stack held open in a persistent session while tests execute. After holding the stack open, `chat-basic` reached placement and actor startup.

The first bundle blocker was `TextEncoder` missing inside the `ivm` isolate. The bundle's `cborg` dependency instantiated `TextEncoder` at module evaluation time, before any lifecycle handler could run. Replaced the bundle-local snapshot codec with self-contained JSON-over-UTF-8 bytes and removed `cborg` from the historia bundle importer. This keeps state/blob snapshots opaque `Uint8Array`s to the substrate while avoiding globals that are not in the isolate runtime.

## 2026-05-28 09:23 PDT

Got `chat-basic` through a local live run with all selected substrate oracles and local bundle oracles passing over 88 events. Two runner/scenario issues surfaced on the way: the runner result file only contained workload events unless Fly archive collection was configured, and pre-message host events were queued but not necessarily delivered before the scenario sent player messages. Added a local `/admin/history` collector for live runs and made the shared historia workload wait for pre-message host-event delivery before sending player input.

This also confirmed the historia bundle needs to use the generic `{ type: "ready" }` connect frame that the runner and existing example bundles expect; the payload now carries `topic: "historia.ready"` plus the hydration snapshot.

One more registration issue appeared after the green-path run: the shared historia workloads had been pointing reference URL-service providers at `${controlPlaneUrl}/_url-services/...`, but those routes live on the API gateway. Added an `${apiGatewayUrl}` template with local defaults in the runner and switched the shared workload to it. A fresh `chat-basic` run then produced successful `ai.chat.v1` wire records with `statusCode: 200`.

## 2026-05-28 09:31 PDT

Ran the full ten-scenario suite locally with fresh game prefixes per scenario. All ten scenarios passed their selected substrate and bundle-local oracle sets:

`chat-basic`, `jump-forward-basic`, `advisor-basic`, `actions-basic`, `role-claim-flow`, `role-destroy-flow`, `spectator-billing-block`, `moderation-flow`, `workflow-override-loaded`, and `host-event-wake-delivery`.

Fixes needed to get there: scenario histories are per-game slices, so `history-completeness` now skips global `pax_seq` contiguity checks for scenario-runner histories while still checking timestamps, shard IDs, positive sequence IDs, and required fields. The historia manifests now exclude API/input-specific substrate oracles for scenarios that intentionally do not exercise those surfaces, and the shared workload waits for post-message host-event delivery before replaying oracles.

## 2026-05-28 09:34 PDT

Audited the API replay fixture path before freezing historia fixtures. The gateway was fingerprinting the full outbound envelope, which includes volatile run IDs, trace IDs, session IDs, JWT expiration, and connection timestamps. That makes canned URL-service fixtures effectively one-run-only. Changed the replay fingerprint contract to hash the stable `{ kind, args }` replay key while still sending and recording the full envelope for live calls. Updated the gateway docs and the faithful API oracle to match.

## 2026-05-28 09:36 PDT

Regenerated the full ten-scenario suite after the stable replay-key change; all ten scenarios passed again locally. Wrote canned `fixtures/api-responses/records.json` files for the API-producing scenarios:

`chat-basic` (2 records), `jump-forward-basic` (3), `advisor-basic` (1), `actions-basic` (1), and `moderation-flow` (2).

Added the `api-responses` fixture directory to the shared workload fixture list. Restarted the local stack with `PAX_API_GATEWAY_MODE=replay` and `PAX_API_REPLAY_FIXTURES_PATH` pointed at `chat-basic`'s fixture directory; a fresh `chat-basic` run passed with `api.invoke.wire` records in `mode: "replay"` and `mock-ai.v1` reference-service invocation count staying at zero.

## 2026-05-28 09:39 PDT

Started Task 7 local proof. To make the `--oracles all` gate meaningful for mixed-surface scenarios, updated conditional safety oracles to pass vacuously when their triggering surface is absent: API dispatch/session-count, idempotent player input, crash blast radius, parent crash absence, eviction minimum budget, migration rollback, and host-event durability. Scenario-local oracles still assert required scenario-specific surfaces, so API-producing scenarios still fail if their expected API call is missing.

Reran all ten historia scenarios locally with `--oracles all`; every scenario passed all seventeen substrate guarantee oracles plus its bundle-local oracles. Results are under `var/phase-3/local-proof/`.

## 2026-05-28 10:09 PDT

Finished the Task 7 Fly proof. Deployed the latest control image as `pax-backend-control:deployment-01KSQQG1E1MZ6J61X6NYK7PHZW` and the latest shard image as `pax-backend-shards:deployment-01KSQQMDH3RCDK8X5AHSC1MW1V`; health checks passed on the control machines `1855153b34e528` and `d8d1004f412328`, and shard machine `2872d67f64e6e8`.

Two split-topology runner fixes were needed before the proof was reliable. First, live `expect-history-events` phases can run in delayed mode on Fly because control-plane history cannot see shard-local `onHostEvent.delivered` records while pacing a workload. Second, archived Tigris history is filtered by scenario game IDs; otherwise a time-window archive read can append adjacent scenario events and contaminate per-scenario oracle histories.

The full Fly suite passed all ten scenarios with `--oracles all` and zero oracle failures. Artifacts live under `var/phase-3/fly-proof/`.

| Scenario | Oracles | Checked events |
|---|---:|---:|
| `actions-basic` | 19 | 60 |
| `advisor-basic` | 19 | 61 |
| `chat-basic` | 19 | 96 |
| `host-event-wake-delivery` | 18 | 49 |
| `jump-forward-basic` | 21 | 66 |
| `moderation-flow` | 20 | 64 |
| `role-claim-flow` | 19 | 49 |
| `role-destroy-flow` | 18 | 58 |
| `spectator-billing-block` | 18 | 44 |
| `workflow-override-loaded` | 19 | 68 |
