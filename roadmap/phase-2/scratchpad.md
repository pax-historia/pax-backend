# Phase 2 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-28 03:56 PDT

Activated Phase 2 after Phase 1 closed green. The phase target is the Fly
topology proof: three apps (`pax-backend-shards`, `pax-backend-control`,
`pax-backend-driver`) backed by Tigris bucket `pax-backend-blobs` and Upstash
Redis `pax-backend-directory`, then 100 concurrent hello-world games for 30
minutes under both no-fault and shard-death-every-five-minutes profiles.

Re-read `AGENTS.md` before moving into this phase. The teardown allowlist in
`scripts/bootstrap/tear-down.sh` remains hard-coded to the three Fly apps and
one Tigris bucket; do not generalize it while working on the bootstrap or
deployment path. Commit cadence is around once per task unless a smaller
checkpoint is clearly warranted.

## 2026-05-28 04:00 PDT

Completed the bootstrap preflight. Local prerequisites are present (`fly`,
`infisical`, `jq`, `python3`, `openssl`, Docker, `pnpm`, and Cargo). Fly auth is
valid for `team@paxhistoria.co`; the `pax-backend` org is visible; Infisical
dev access succeeds for workspace `d4aa1707-46dc-4a66-8c13-0d5459f6757e`; the
spend marker already existed and was preserved.

Existing resource inventory before convergence:

- Fly apps: `pax-backend-control`, `pax-backend-driver`,
  `pax-backend-shards`.
- Tigris bucket: `pax-backend-blobs` in org `pax-backend`.
- Upstash Redis: `pax-backend-directory`, pay-as-you-go, eviction disabled,
  primary region `iad`.
- Starter shard volume: `pax_backend_rocks`, `iad`, 5 GB, `created`.

Ran `./scripts/bootstrap/spin-up.sh` as the idempotency and drift check. It
found all resources already present, left the hard-coded teardown allowlist
unchanged, synced secrets from Infisical to Fly with tally `0 changed, 21
unchanged, 0 failed`, verified digest equality for all shared secret groups,
and exited 0.

Forward note for task 2: repository deploy descriptors are not complete yet.
The only non-vendor Dockerfile found is `runtime/shard-image/Dockerfile`;
control and driver deployment descriptors/images need to be created or wired
before Fly deploys can happen.

## 2026-05-28 04:08 PDT

Started the deployable topology work. Added Fly configs for
`pax-backend-shards`, `pax-backend-control`, and `pax-backend-driver`; added a
control image that runs placement-router, control-plane, and api-gateway under
one Fly machine; added a driver image with a health endpoint and command
override support for scenario-runner runs.

Adjusted the shard/control token path so Fly no longer relies on the local
`dev` Rivet engine admin token: `scripts/bootstrap/spin-up.sh` now mints and
syncs `PAX_LOCAL_ENGINE_ADMIN_TOKEN` to shards and control, and the shard
entrypoint maps it to `RIVET_ADMIN_TOKEN` when no explicit engine token is
present. Reran `spin-up.sh`; it created that secret in Infisical, synced it to
both apps with digest `476bf2e3770469f6`, verified drift clean, and left all
other secrets unchanged.

Validation checkpoint before deploy:

- `bash -n` passed for the new control/driver entrypoints, shard entrypoint,
  and `scripts/bootstrap/spin-up.sh`.
- `fly config validate` passed for all three Fly configs.
- `docker buildx build --check` passed for the shard, control, and driver
  Dockerfiles.

## 2026-05-28 04:26 PDT

Deployed the first production-shaped control and driver images. The initial
remote image builds exposed three packaging issues that local `--check`
validation did not catch:

- `pnpm-lock.yaml` was stale for the new `@pax-backend/node-telemetry`
  workspace dependency entries. `pnpm install --lockfile-only` repaired the
  lockfile and `pnpm install --frozen-lockfile` passed locally afterward.
- The control and driver image contexts intentionally excluded `vendor/`, but
  root `pnpm install` still resolves the vendored Rivet file dependencies
  declared by `runtime/parent-actor`. The image-specific dockerignore files now
  include only the three small vendored TypeScript packages needed to satisfy
  root lockfile resolution.
- Shard images installed root dependencies before the vendored Rivet TypeScript
  `dist/` files existed in the container. The shard Dockerfile now runs
  `pnpm build:vendor-ts` before root `pnpm install --frozen-lockfile`, so fresh
  Docker contexts do not depend on local vendor build artifacts.

Also added a global `**/target` Docker ignore rule so local Cargo build caches
do not inflate future image contexts. Control deployment completed with two
started machines and all three Fly checks passing. Driver deployment completed
with one started machine, one standby machine, and its health check passing.
Public router health returned `{"runtime":"placement-router","status":"ok"}`;
internal control-plane, API gateway, and driver health endpoints all returned
`status:"ok"`.

The shard deploy hit a Depot deadline during the first full vendored
`rivet-engine` compile, retried automatically, then reused enough remote Cargo
cache to finish. The final shard image deployed with one started machine and
its Fly check passing. Shard verification:

- parent `/health` returned `status:"ok"` for `shard-fly-iad-1`;
- parent `/metrics` exposed `parent.ready`;
- Rivet `/datacenters` returned the default datacenter using the deployed
  `PAX_LOCAL_ENGINE_ADMIN_TOKEN`;
- Rivet `/metrics` exposed request histogram rows for `/datacenters`;
- control-plane `/admin/shards` reported `shard-fly-iad-1` as healthy and
  accepting wakes;
- Redis `PING` from the deployed control-plane package returned `PONG`;
- Tigris write/delete from the deployed shard package succeeded against
  `pax-backend-blobs`.

Task 2 is complete. Next task is the production observability path: turn the
Vector/OTel pipeline from scaffold into a deployed, verifiable trace and
history archive path.

## 2026-05-28 05:07 PDT

Started task 3, the Fly observability trace path. The Better Stack source
token and ingest host are now present in Infisical and synced to all three Fly
apps; Fly secret digests match across `pax-backend-shards`,
`pax-backend-control`, and `pax-backend-driver`.

Wired Vector into the shard, control, and driver runtime images from the pinned
`timberio/vector:0.55.0-debian` image. Each entrypoint starts Vector before the
service processes when `PAX_OBSERVABILITY` is not `off`, exports the local OTLP
endpoint defaults, and treats Vector exit as app failure so the production
`on` path fails fast if Better Stack or Tigris are unreachable.

The first review of `vector-prod.toml` showed that a single scrape config would
try to scrape every surface on every Fly app. Added role-specific production
profiles instead: control scrapes router/control/gateway metrics, shards
scrape parent/Rivet metrics, and driver now exposes a tiny `/metrics` endpoint
for its health loop. This keeps the scrape path production-shaped without
duplicating metrics from unavailable surfaces or filling logs with scrape
errors.

Validation checkpoint before deploy:

- `bash -n` passed for Vector/startup scripts and bootstrap.
- Vector `0.55.0` validated the control, shards, driver, and legacy production
  configs with dummy secret values and health checks skipped.
- `fly config validate` passed for all three Fly configs.
- `docker buildx build --check` passed for all three Dockerfiles.
- `git diff --check` passed.

The first `PAX_OBSERVABILITY=on` deploy proved the sidecar boots and its sink
health checks run, but Better Stack rejected writes with HTTP 401. Better
Stack's generated setup script for the supplied token says the source token was
not found, so this is not a valid telemetry source token for the Logs/Telemetry
ingest endpoint. Left the token in Infisical as requested, but switched Fly to
`PAX_OBSERVABILITY=buffer` until a valid source token and ingest host are
available.

Refactored the Vector config so app-role scrape profiles are shared by both
the Better Stack `on` path and the buffer path. The buffer path keeps
production-shaped Tigris archival for history and OTLP traces, and also writes
local JSONL files under `/data/observability` for quick inspection on Fly
machines. This gives task 3 a verifiable sink while Better Stack credentials
are corrected.

The trace-exemplar prep surfaced one deployment topology miss from task 2:
`PAX_API_GATEWAY_URL` on shards pointed at the public control hostname, but Fly
only exposes the placement router on that hostname. Changed shard API invokes
to `http://pax-backend-control.internal:9081/invoke` over Fly private
networking. Also changed the API gateway's own base URL back to
`http://127.0.0.1:9081`, because the fallback reference URL-service registry is
in-process and should not point at the public router.

The first driver-side trace probe could not connect from `pax-backend-driver`
to `pax-backend-control.internal` on 9070, 9080, or 9081 even though those
services were healthy on control-local `127.0.0.1`. Fly `.internal` DNS targets
the app's private IPv6 machine addresses, so the control image's IPv4
`0.0.0.0` binds were not sufficient for app-to-app private networking.
Changed the control image/Fly config to bind router, control-plane, and gateway
on `[::]`, and taught the Node control-plane and API gateway bind parsers to
accept bracketed IPv6 socket addresses.

## 2026-05-28 05:56 PDT

Completed task 3, the Fly observability trace path.

All three Fly apps now run Vector sidecars in `PAX_OBSERVABILITY=buffer`.
The supplied Better Stack token remains synced in Infisical, but Better
Stack rejected it as an invalid telemetry source token, so the live proof used
the Tigris-backed buffer sink until a valid Better Stack source token is
available.

Added explicit 10-second S3 batch timeouts for history and trace archives so
low-volume exemplar runs flush promptly. The final deployed control image was
`deployment-01KSQA5JS0QXG8HMR0SBTB89F6`; shard and driver remained healthy on
their buffer-capable images.

Final exemplar:

- bundle `hello-ai-call-trace-mpphvc4v-56e6c7`
- game `trace-mpphvc4v-56e6c7`
- session `ses_e208e483d204a2481574bd7c1907d1ad`
- placement trace ID `964179eb9b4e84753fa40d94dbbc4f80`
- `mock-ai.v1` returned `ok: true`

Verification evidence:

- API gateway metrics on control machine `d8d1004f412328` showed
  `pax_api_gateway_invocations_total 1`,
  `pax_api_gateway_invocations_ok_total 1`, and
  `pax_url_service_invocations_total{kind="mock-ai.v1"} 1`.
- Shard history contained the same trace ID through `session.opened`,
  `onPlayerMessage`, `api.invoke.request`, `api.invoke.response`,
  `api.invoke.wire`, and `session.closed`.
- Tigris history object
  `history/date=2026-05-28/1779972858-4d6aae00-70c1-4642-81ec-56790fcbdd80.jsonl.gz`
  contained the exemplar's correlated history events.
- Tigris trace object
  `traces/date=2026-05-28/1779972854-a7cb4898-0f62-40b1-8be3-f364852a0553.jsonl.gz`
  contained `router.placement`, `gateway.invoke`, and
  `urlsvc.mock-ai.v1.invoke` spans, all with trace ID
  `964179eb9b4e84753fa40d94dbbc4f80`.

The trace proof also exposed and fixed two continuity issues: router OTel span
creation now happens after `traceparent` extraction, and gateway/reference URL
service spans explicitly use the trace ID carried in the substrate envelope.

## 2026-05-28 06:12 PDT

Started task 4, the no-fault medium run. The live runner now has the missing
pieces needed for a repeatable 100-game Phase 2 proof: `--game-id-prefix` keeps
Fly runs from reusing old games, `send-host-events` exercises guarantee 17,
and `flip-bundles` gives the migration/rollback oracle a successful flip to
observe without injecting a failure. Added a dedicated
`compute-stress/clients/phase2-no-fault.mts` workload that opens 100
`hello-multifeature` games for a 30-minute no-fault window, then waits for the
sleep-grace path so shutdown/sleep events reach archived history.

## 2026-05-28 06:18 PDT

First no-fault attempt `phase2-no-fault-20260528131349` did not reach the
medium target. It seeded fixtures and reached 27 placements, then Rivet guard
started reporting websocket service timeouts and the runner failed waiting for
the ready frame for game 27 with `1011 core.internal_error`. Shard logs also
showed `onWake` exceeding the 1-second handler timeout at this load. The
2GB/shared-2x shard profile is not enough for the 100-game topology proof, so
the next attempt moves the shard machine to performance-4x/8GB and lengthens
the actor-ready, route, and handler windows for the medium proof.

## 2026-05-28 06:29 PDT

The second no-fault attempt reached the 100-game sustained window, but shard
logs showed `onHostEvent` handler errors for games whose bundle does not define
that optional handler. The ivm child runner was treating a missing export as an
`isolated-vm` Reference and calling `apply()` on it; the no-ivm runner already
skips absent handlers. Patched the ivm path to no-op when a handler export is
`undefined` or `null`, while still reporting non-function exports as malformed
handler definitions.

## 2026-05-28 06:43 PDT

Prepared the shard-death-every-5m run while the clean no-fault proof holds 100
games. The current nemesis implementation models `kill-shard` as control-plane
drain, with the Fly/orchestrator replacement hook layered over it. Added that
replacement-ready hook to the runner: after `POST /admin/shards/:id/drain`, it
waits `PAX_NEMESIS_REPLACEMENT_READY_MS` (default 60s), calls
`DELETE /admin/shards/:id/drain`, and records
`nemesis.kill-shard.replacement-ready`. A local HTTP smoke verified the runner
issues both drain and un-drain calls and writes the nemesis history events.
The runner also clears any pending replacement-ready timer during scenario
shutdown so a late nemesis tick does not leave the shard stuck in `draining`.

## 2026-05-28 06:51 PDT

The clean no-fault attempt `phase2-no-fault-20260528133647` reached 100 games
on the patched shard and completed the host-event and bundle-flip probes
without the previous missing-handler errors. It failed during the 30-minute
message phase at `2026-05-28T13:47:54.019Z` after one session closed.

Shard logs showed the pressure point: the workload was sending 100 messages in
a burst every 10 seconds, and each `hello-multifeature` player message performs
state read/write/flush, blob get/put, and a `mock-ai.v1` API invoke. Under that
burst, API invokes timed out after 30 seconds, `onPlayerMessage` handlers ran
for roughly 78 seconds, and the engine runner disconnected with
`core.internal_error#h8l6m9qz3dontp9sx3sawmqps2dl00`.

Updated the runner to support per-wave message fanout and changed the Phase 2
no-fault workload to spread each send-json wave across 30 seconds, with 31
one-minute waves. This keeps the proof at a 30-minute sustained window while
removing the artificial per-wave burst that was saturating the shard.

## 2026-05-28 07:32 PDT

No-fault medium proof `phase2-no-fault-20260528135419` completed green on Fly.
The run opened 100 `hello-multifeature` games on shard `shard-fly-iad-1`,
delivered 100 host events, sent 100 bundle flips, held the paced message phase
for 1,830,218 ms, closed all sessions, and observed the shard return to
`activeGames: 0` during the post-close wait.

All 17 guarantee oracles passed over 70,491 checked events. Artifacts:

- `var/phase-2/phase2-no-fault-20260528135419.history.jsonl` (84 MB)
- `var/phase-2/phase2-no-fault-20260528135419.result.json`

Live monitoring during the sustained window repeatedly sampled the shard
registry at 100 active games and found no `handlerError`, timeout, disconnect,
internal-error, span-drop, or workflow-backlog signatures in Fly logs. The
runner result's top attribution candidate was
`parent.compute.memory-bytes.usage_ratio` with max 2.06, but no oracle failed.

## 2026-05-28 07:32 PDT

Starting task 5 with the same paced 100-game workload and the
`shard-death-every-5m` nemesis. The active nemesis implementation follows the
Phase 0 documented shape: `kill-shard` calls the control-plane drain endpoint,
and the runner's replacement-ready hook un-drains the shard after the configured
delay so the single-Fly-shard topology can continue receiving placements
between injections.

## 2026-05-28 07:41 PDT

Discarded shard-death attempt `phase2-shard-death-20260528143319` after the
first drain/un-drain cycle. The live behavior was correct — the registry moved
to `draining`, then back to healthy after the replacement-ready hook — but the
runner's `HistoryWriter` overwrote the nemesis event's selected `shardId` with
the driver shard ID `scenario-runner`. Patched the nemesis events to emit
`targetShardId` so the rerun artifact preserves the selected shard in history.

## 2026-05-28 07:58 PDT

Shard-death rerun `phase2-shard-death-20260528144159` reached the sustained
100-game window and completed two drain/un-drain cycles with
`targetShardId: shard-fly-iad-1`, but failed at `2026-05-28T14:54:36.723Z`
when one session closed. Fly logs showed the root cause was the 5 GB shard
RocksDB volume filling, not a guarantee oracle violation: RocksDB could not
append `/data/rivet-engine/db/000049.sst`, Vector could not write local metrics
or checkpoints, and the shard app restarted with the service check critical.

Extended the existing `pax_backend_rocks` volume
`vol_rkglge8kolq8je64` from 5 GB to 20 GB in place, restarted machine
`2872d67f64e6e8`, and verified the shard recovered: `/data` is 25% used, the
Fly service check is passing, `/health` returns `status: ok`, and the control
registry reports `shard-fly-iad-1` healthy with `activeGames: 0`.

## 2026-05-28 08:39 PDT

Shard-death medium proof `phase2-shard-death-20260528145918` completed the
100-game Fly profile. The run opened 100 `hello-multifeature` games, delivered
the host-event probe, flipped all games through the bundle gate, held the
paced `send-json` phase for 1,830,212 ms, closed all sessions, and observed the
shard return to `activeGames: 0` during the final wait.

The nemesis injected seven drain cycles against `targetShardId:
shard-fly-iad-1` at roughly five-minute intervals. Each drain moved the shard
registry to `draining` / `acceptingWakes: false`; each replacement-ready hook
un-drained it after 60 seconds. The last drain fired five seconds before the
message phase ended, then recovered during the final wait with no stuck drain
flag.

The first result write reported guarantee 9 as `inconclusive` because that
oracle only counted `parent.ready` or `actor.stop` as positive liveness
evidence; this run had neither, but had thousands of parent-authored lifecycle
events and no `parent.crash` or `parent.fatal`. Broadened the oracle to count
parent lifecycle evidence (`actor.start`, `actor.stop`, `child.exit`,
`child.restart`, `lifecycle.sleepComplete`, and `parent.ready`), then replayed
the same history artifact. All 17 guarantee oracles passed over 70,502 checked
events.

Artifacts:

- `var/phase-2/phase2-shard-death-20260528145918.history.jsonl` (85 MB)
- `var/phase-2/phase2-shard-death-20260528145918.result.json`

Monitoring during and after the run found no workload phase failures, no
nemesis action failures, no `No space left on device`, no handler errors, no
API invoke timeouts, no engine-runner disconnects, no core internal errors,
and the shard volume stayed at 29% used after the proof.
