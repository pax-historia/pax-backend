# Phase 0 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-28 01:44 PDT

Completed the Phase 0 `c.state` storage scaffold. The parent no longer
persists state through Redis: `c.state.write` CBOR-encodes the value for
budget accounting, updates the per-game in-process cache, marks a revision
dirty, and schedules a flush inside `PAX_STATE_FLUSH_WINDOW_MS` (default
1000 ms). `c.state.flush()` cancels any scheduled timer and writes the latest
dirty revision synchronously. Planned sleep and on-sleep deadline handling now
flush pending state before killing the child; if the object store is
unavailable, the parent records the failure and does not release the child.

Production configuration uses the Tigris S3-compatible object store via
`BUCKET_NAME`/`PAX_TIGRIS_BUCKET`, `AWS_REGION`, and optional
`AWS_ENDPOINT_URL_S3`. When no bucket is configured, local development uses a
filesystem object store rooted at `PAX_LOCAL_TIGRIS_DIR` or
`var/tigris-local`; it preserves the canonical object key
`state/<gameId>.cbor` so the runtime path remains object-store-shaped without
requiring production secrets on a Mac.

Verification: `pnpm --filter @pax-backend/parent-actor check-types` and
`pnpm --filter @pax-backend/parent-actor build` both pass. Full
`pnpm typecheck` still fails on existing scaffold issues outside this change:
control-plane inline snapshot typing, control-plane API wire-record return
typing, manifest narrowing, API gateway context casting, and the
`examples/url-services/billing-mock.v1` refund record shape.

## 2026-05-28 01:53 PDT

Completed the Phase 0 keyed `c.blob` scaffold. The shared IPC contract now
uses `blob.put`, `blob.get`, `blob.delete`, and `blob.list` with blob bytes
encoded as base64 over JSON-mode child IPC; the SDK-facing surface exposes
`Uint8Array` to bundles. Both child runners were migrated to that contract.

The parent now stores blob keys in the object store at
`blob/<gameId>/<key>`, validates namespace-relative keys, lists the namespace
before writes, and enforces both `blob-bytes` (100 MiB) and `blob-keys`
(1024) before issuing a PUT. Deletes are idempotent, list supports prefix
filtering, and `c.compute.budget()` now reports `blob-keys` alongside
`blob-bytes`.

Updated the runtime SDK harness, hello blob/multifeature bundles, blob
durability and compute-budget oracles, history completeness requirements, and
scenario workload event expectations to the keyed event names. Focused
verification passed:
`@pax-backend/ipc-protocol build`, `@pax-backend/runtime-sdk check-types` and
`build`, `@pax-backend/child-runner-{ivm,noivm} check-types` and `build`,
`@pax-backend/parent-actor check-types` and `build`,
`@pax-backend/runtime-sdk-test-harness check-types`,
`@pax-backend/oracles-lib check-types`,
`@pax-backend/scenario-runner check-types`, and check/build for
`hello-blob-rw` plus `hello-multifeature`.

Full `pnpm typecheck` still fails on the same seven scaffold issues noted in
the previous entry: control-plane inline snapshot typing, API wire-record
typing, manifest narrowing, API gateway context casting, and the existing
`examples/url-services/billing-mock.v1` refund record shape.

## 2026-05-28 01:58 PDT

Completed the object-backed bundle upload path and started the shard-side
bundle cache. Control-plane uploads now require compiled source, validate the
manifest, compute `sha256:<hex>`, write `source.js`, `manifest.json`, and
`metadata.json` to the object store under `bundles/<bundleName>/`, read
`source.js` back to verify the sha, then finalize the Redis `bundles:<name>`
row with object metadata instead of embedding source. The local development
fallback uses the same `var/tigris-local` object-key layout as state/blob.

The parent can now load object-backed bundle records: it fetches
`sourceObjectKey` from the object store, verifies `contentSha256`, writes a
local `source.js` cache under `PAX_BUNDLE_CACHE_DIR` (default
`var/bundle-cache`), and uses a valid cache hit on future wakes. Legacy smoke
records without object metadata still fall back to local example bundles.
Cache bounding/eviction remains open, so Phase 0 task 4 is only
`in_progress`.

Focused verification passed:
`@pax-backend/ipc-protocol build`, `@pax-backend/control-plane check-types`
and `build`, `@pax-backend/parent-actor check-types` and `build`, and
`@pax-backend/api-gateway check-types` and `build`. Full `pnpm typecheck` is
now blocked only by the pre-existing `examples/url-services/billing-mock.v1`
refund-record type error. Per the phase constraints, I left that billing-shaped
example untouched.

## 2026-05-28 01:59 PDT

Closed the remaining shard-side bundle cache gap. Parent cache hits now update
the cached `source.js` mtime, and cache writes prune least-recently-used files
until total cache bytes are at or below `PAX_BUNDLE_CACHE_MAX_BYTES` (default
512 MiB). This keeps the object-backed bundle fetch path bounded while still
treating the cache as scratch space.

Verification: `pnpm --filter @pax-backend/parent-actor check-types` and
`pnpm --filter @pax-backend/parent-actor build` both pass.

## 2026-05-28 02:05 PDT

Completed the shard-image scaffold. `runtime/shard-image/Dockerfile` is now a
multi-stage build: one stage builds the vendored `rivet-engine` without editing
`vendor/rivet`, one stage installs the root pnpm workspace, builds the vendored
RivetKit TS packages, parent actor, both child runners, IPC/runtime SDK, and
example bundle fallbacks, then the final image copies only the runtime tree,
pnpm node_modules, compiled bundle fallbacks, and the engine binary.

Added `runtime/shard-image/entrypoint.sh` to generate the same production-shaped
engine config as the local dev loop, default container paths to `/data`, bind
parent metrics on `0.0.0.0:7700`, and run `rivet-engine` plus the parent actor
as sibling processes with signal forwarding. Added a repo-root `.dockerignore`
so shard builds do not send local caches, node_modules, build outputs, or
vendored Rust targets as context.

Verification: `bash -n runtime/shard-image/entrypoint.sh` passes, and
`docker buildx build --check -f runtime/shard-image/Dockerfile .` completed
with no warnings. I did not run a full image build here because compiling the
vendored engine inside Docker is intentionally a long Phase 1/2 validation
step.

## 2026-05-28 02:18 PDT

Completed the first live scenario-runner phase executor. Added
`testing/scenario-runner/src/live-executor.mts`, which talks to a running
control plane and placement router, uploads the compiled example bundle when
needed, seeds games and allowed players from workload fixtures, opens real
Rivet WebSocket sessions, sends JSON frames, closes sessions, registers
API kinds, waits, and polls `/admin/history` for expected per-game events.
The executor also records `placement.accepted`/`placement.rejected` driver
history entries with a per-runner `pax_seq`, matching the smoke bot pattern
that the placement router itself does not write history.

`runner.mts` now executes the live workload before replaying the resulting
history through the oracle shell whenever `mode !== "replay"`. Replay mode
keeps the old behavior. CLI flags `--control-url`, `--router-url`, and
`--phase-timeout-ms` target non-default live surfaces. The catalog validator
now checks workload phase payloads and normalizes docs-style `phase` to the
repo's `type` field.

Verification: `pnpm --filter @pax-backend/scenario-runner check-types` and
`pnpm --filter @pax-backend/scenario-runner build` pass. A replay CLI sanity
check against an intentionally empty history emitted `result.json` and exited
with the expected oracle-blocking code 2.

## 2026-05-28 02:20 PDT

Closed the live oracle-gate gap and pulled the guarantee #17 oracle forward.
The scenario-runner already used `buildScenarioResult` after replay; now the
non-replay path executes the live workload first, then reuses that same history
read/oracle/result pipeline, so `result.json` is emitted for live runs and the
CLI exits non-zero when any oracle status is not `pass`.

Added `testing/oracles-lib/src/guarantees/host-event-durability.mts` and wired
it into the guarantee index as G17. The oracle watches `onHostEvent.received`
and `onHostEvent.delivered`, requiring every durable `wakeOnDelivery` receipt
to have at least one matching delivery and validating `deliveryAttempts` when
present. `history-completeness` now knows the required fields for both
host-event history events.

Verification: `pnpm --filter @pax-backend/oracles-lib check-types`,
`pnpm --filter @pax-backend/oracles-lib build`,
`pnpm --filter @pax-backend/scenario-runner check-types`, and
`pnpm --filter @pax-backend/scenario-runner build` all pass. A replay CLI
sanity check with `--oracles all` against an intentionally empty history
produced a result containing `G17_host_event_durability` and exited with the
expected oracle-blocking code 2.

## 2026-05-28 02:57 PDT

Completed the nemesis runtime injector. The runner now constructs a
`NemesisRuntime` for live runs and starts it before workload phases. The
`no-faults` manifest is a no-op. `shard-death-every-5m` schedules
`kill-shard` timers, selects eligible shards from `GET /admin/shards`, maps
the current Phase 0 admin REST action to
`POST /admin/shards/:id/drain`, records `nemesis.kill-shard.injected` driver
history, and tracks occurrences so the workload `await-nemesis` phase can
block until the requested injection count is observed.

This is intentionally admin-REST-shaped rather than Fly-machine-kill-shaped
for Phase 0: the orchestrator replacement hook lands later, while the runner
now has the scheduling, selection, history, and phase coordination paths in
place.

Verification: `pnpm --filter @pax-backend/scenario-runner check-types` and
`pnpm --filter @pax-backend/scenario-runner build` pass. A replay CLI sanity
check against the shard-death scenario still emits `result.json` and exits
with the expected oracle-blocking code 2 on empty history.

## 2026-05-28 03:03 PDT

Completed the host-event delivery scaffold across control plane, placement
wake, IPC, parent, child runners, SDK types, and the G17 oracle path.
Control plane now exposes `POST /admin/games/:id/host-event`, emits
`onHostEvent.received`, drops best-effort events for asleep games, and queues
deliverable host events in Redis under `host_events:<gameId>` with the
30-day TTL. For sleeping `wakeOnDelivery` events, it calls the placement
router and opens a short synthetic Rivet WebSocket to trigger actor start;
the synthetic player is rejected by the parent allowed-player gate after the
actor wakes.

The shared IPC contract now has `OnHostEventPayload`, `HostEventRecord`, and
the parent-to-child `onHostEvent` envelope. Parent actors drain queued host
events after wake and on a short active-game interval, send the handler to the
child, and emit `onHostEvent.delivered` with event id, event type, payload,
`wakeOnDelivery`, and delivery attempt count. Both child runners dispatch the
new handler, and the runtime SDK exposes the `onHostEvent` bundle hook type.

Verification passed in dependency order:
`@pax-backend/ipc-protocol build`, `@pax-backend/runtime-sdk build`,
`@pax-backend/child-runner-noivm build`,
`@pax-backend/child-runner-ivm build`,
`@pax-backend/parent-actor build`,
`@pax-backend/control-plane build`, and
`@pax-backend/oracles-lib build`.

## 2026-05-28 03:06 PDT

Completed the drain ACK closure. Parent shard registration now includes a
first-class `status` and reports `drained` when a shard has a drain request
and zero active games. Control plane derives a backwards-compatible shard
view for admin reads, keeps `currentGameCount` visible on
`GET /admin/shards/:id`, and emits `shard.drain.completed` once when a drain
request or shard read observes the drained state.

Verification: `pnpm --filter @pax-backend/ipc-protocol build`,
`pnpm --filter @pax-backend/parent-actor check-types`,
`pnpm --filter @pax-backend/control-plane check-types`,
`pnpm --filter @pax-backend/parent-actor build`, and
`pnpm --filter @pax-backend/control-plane build` all pass.

## 2026-05-28 03:12 PDT

Completed the Vector sidecar configs. `scripts/observability/vector-prod.toml`
now defines the production sidecar topology: stdin logs, history JSONL tail,
OTLP gRPC/HTTP ingress, per-surface Prometheus scrapes, Vector internal
metrics, enrichment transforms, a Prometheus-bound cardinality firewall,
BetterStack HTTP shipping, and a Tigris/S3 history archive with disk
buffers. `scripts/observability/vector-local-dev.toml` mirrors the same
sources and transforms but keeps sinks local through a Prometheus exporter,
console JSON, and a local history archive file.

The cardinality firewall removes raw `game_id`, `session_id`, `player_id`,
`actor_id`, `actor_id_gen`, `trace_id`, `request_id`, `bundle_name`, and
`database_id` tags before metrics reach Prometheus-shaped sinks. OTLP metrics
also pass through that firewall; OTLP logs and traces remain raw for the
trace/log sinks.

Verification: both files parse with Python `tomllib`. Vector's own validator
passes with `--skip-healthchecks --deny-warnings` for both configs using the
official `timberio/vector:latest-debian` image. The prod config also loads
and reaches component configuration with live health checks; the dummy Tigris
endpoint used during validation cannot satisfy the `aws_s3` sink health
check, so the final prod validation intentionally skipped health checks.

## 2026-05-28 03:18 PDT

Completed the Node OpenTelemetry SDK wiring. Added the
`@pax-backend/node-telemetry` workspace package with a shared
`startPaxNodeTelemetry` helper around `@opentelemetry/sdk-node`,
`@opentelemetry/auto-instrumentations-node`, and the OTLP/gRPC trace
exporter. The helper respects `PAX_OBSERVABILITY=off`,
`OTEL_SDK_DISABLED=true`, and `OTEL_TRACES_EXPORTER=none`, defaults traces to
`http://127.0.0.1:4317`, and stamps service/resource attributes including
`pax.zone`, `pax.runtime_contract`, optional `pax.run_id`, and Fly metadata.

Parent actor, control plane, and API gateway now start the shared SDK on
process startup. The API gateway wraps dispatch in a `gateway.invoke` span,
and the reference URL-service router wraps each in-process handler with
`urlsvc.<kind>.invoke` while preserving the existing reference-service
metrics.

Verification: `pnpm --filter @pax-backend/node-telemetry check-types`,
`pnpm --filter @pax-backend/node-telemetry build`,
`pnpm --filter @pax-backend/url-services check-types`,
`pnpm --filter @pax-backend/api-gateway check-types`,
`pnpm --filter @pax-backend/control-plane check-types`,
`pnpm --filter @pax-backend/parent-actor check-types`, and focused builds for
url-services, api-gateway, control-plane, and parent-actor all pass.

## 2026-05-28 03:23 PDT

Completed the Rust OpenTelemetry SDK wiring for the placement router. The
router now initializes a `tracing-opentelemetry` layer with an OTLP/gRPC span
exporter, defaulting to `http://127.0.0.1:4317` and respecting
`PAX_OBSERVABILITY=off`, `OTEL_SDK_DISABLED=true`, and
`OTEL_TRACES_EXPORTER=none`. Resource attributes include
`service.name=pax-placement-router`, `service.namespace=pax-backend`,
`pax.zone=orchestration`, `pax.runtime_contract`, optional `pax.run_id`, and
Fly metadata.

The `router.placement` span now uses `#[tracing::instrument]`, records
placement attributes, and adopts the inbound W3C `traceparent` via the global
TraceContext propagator before the placement token receives the same trace id.

Verification: `cargo fmt --manifest-path orchestration/placement-router/Cargo.toml`,
`cargo check --manifest-path orchestration/placement-router/Cargo.toml`, and
`cargo build --manifest-path orchestration/placement-router/Cargo.toml` all
pass.

## 2026-05-28 03:25 PDT

Completed the vendored-engine OTel pass-through wiring. Local engine launch
(`scripts/dev/spawn-engine.mts`) and the shard image entrypoint now default
`RIVET_OTEL_ENABLED=1` unless `PAX_OBSERVABILITY=off`, set
`RIVET_OTEL_GRPC_ENDPOINT` from the standard OTLP endpoint envs with
`http://127.0.0.1:4317` as the default, set `RIVET_OTEL_SAMPLER_RATIO=1`,
and default `RUST_TRACE=info` so the vendored OTel layer has an enabled trace
filter.

Source confirmation from `vendor/rivet/` without editing it:
`rivet_metrics_server::init_otel_providers` keys off
`RIVET_OTEL_ENABLED=1`, uses `RIVET_OTEL_GRPC_ENDPOINT`, and installs a
parent-based sampler. Rivet runtime initializes that provider before its
tracing subscriber, and the guard/API middleware uses
`OpenTelemetrySpanExt` for request context bridging.

Verification: `bash -n runtime/shard-image/entrypoint.sh`,
single-file TypeScript check for `scripts/dev/spawn-engine.mts`, `rg` audit
for the relevant `RIVET_OTEL_*` envs, and
`docker buildx build --check -f runtime/shard-image/Dockerfile .` all pass.

## 2026-05-28 03:27 PDT

Completed the runtime SDK module split. The root
`sdk/runtime-sdk/src/index.mts` is now a compatibility barrel. Contract
surface lives in focused modules:
`manifest.mts`, `lifecycle.mts`, `storage.mts`, `compute-budgets.mts`,
`external-api-channel.mts`, plus `context.mts` for the aggregate
`SubstrateContext`. Existing public imports such as
`defineBundle`, `BundleDefinition`, and the IPC-derived payload/response
types remain available from `@pax-backend/runtime-sdk`.

Verification: `pnpm --filter @pax-backend/runtime-sdk check-types`,
`pnpm --filter @pax-backend/runtime-sdk build`,
`pnpm --filter @pax-backend/runtime-sdk-test-harness check-types`,
`pnpm --filter @pax-backend/bundle-tools check-types`, and
`pnpm build:bundles` all pass.

## 2026-05-28 03:29 PDT

Completed the bundle publish CLI path. `pax-bundle publish <pkg>
--control-plane-url <url> --bundle-name <name>` reads the compiled
`dist/bundle.js`, extracts the manifest from the bundle install footer, and
POSTs `{ manifest, source }` to `/admin/bundles/:bundleName`. The built CLI
now points the package bin at `dist/cli.mjs` and lazy-loads command modules so
the publish path does not import verify-only harness dependencies at startup.

Verification: `pnpm --filter @pax-backend/bundle-tools check-types`,
`pnpm --filter @pax-backend/bundle-tools build`, and a fake-control-plane CLI
smoke using `node sdk/bundle-tools/dist/cli.mjs publish
examples/bundles/hello-ws-echo --control-plane-url <local server>
--bundle-name hello-ws-echo-test` all pass. The smoke observed a `POST` to
`/admin/bundles/hello-ws-echo-test` with the expected manifest and source
body.

## 2026-05-28 03:34 PDT

Completed the reference URL service hardening pass. The API gateway envelope
builder already stamped `X-Gateway-Envelope-Version: 2` for outbound URL
service calls; co-located `/_url-services/*` routes now enforce that same
version header before parsing or dispatching to the in-process reference
handlers. Existing `http.fetch.v1` allowlist enforcement rejects non-matching
hosts, and the shared helper rejects non-HTTP(S) targets even when the
allowlist contains `*`.

Verification: `pnpm --filter @pax-backend/api-gateway check-types`,
`pnpm --filter @pax-backend/url-services check-types`,
`pnpm --filter @pax-backend/api-gateway build`, and
`pnpm --filter @pax-backend/url-services build` all pass. A focused
`tsx` contract smoke invoked `echo.v1`, `delay.v1`, `http.fetch.v1`, and
`mock-ai.v1` through `ApiGateway` with a capture fetch and confirmed each
request carried envelope version `2`; the same smoke confirmed
`http.fetch.v1` returns `403 targetNotAllowed` for a non-allowlisted URL and
that `data:` remains denied under wildcard allowlist.

## 2026-05-28 03:42 PDT

During the Phase 0 verification pass, found one missing lifecycle piece from
`docs-next/contract/lifecycle-and-wake.md` and
`docs-next/subsystems/redeploy-and-drain.md`: the parent did not yet start the
60s last-disconnect sleep grace, so naturally sleeping games could not release
their active-game row and drain completion would stay blocked.

Implemented the parent-side sleep grace. After the last session closes, the
parent starts `PAX_SLEEP_GRACE_MS` (default 60000 ms), cancels it on reconnect
or explicit sleep, and sends `onSleep` with `reason: "idle"` on expiry. Normal
`lifecycle.sleepComplete` and deadline paths now flush state, delete the
`active_games:<gameId>` row, mark the game inactive for shard registration, and
set the next wake reason to `cold-restart-from-storage`. The shared IPC
contract now matches the docs for `cold-restart-from-storage` and the full
sleep reason union. Crash restarts also now stamp the documented optional
`errorClass` on `onWake` after `cold-restart-after-crash`.

Also aligned the history catalog and history-completeness oracle with the
actual lifecycle event names: `lifecycle.sleepComplete`, `onSleep.deadline`,
`lifecycle.sleepGrace.*`, and `game.released`.

Verification: `pnpm --filter @pax-backend/ipc-protocol build`,
`pnpm --filter @pax-backend/parent-actor check-types`,
`pnpm --filter @pax-backend/parent-actor build`,
`pnpm --filter @pax-backend/runtime-sdk check-types` and `build`,
`pnpm --filter @pax-backend/child-runner-noivm check-types` and `build`,
`pnpm --filter @pax-backend/child-runner-ivm check-types` and `build`, and
`pnpm --filter @pax-backend/oracles-lib check-types` and `build` all pass.
Root `pnpm typecheck` remains blocked only by the existing
`examples/url-services/billing-mock.v1` refund record missing `eventId`;
this is outside the substrate and is queued for Phase 1's local build pass.

## 2026-05-28 03:46 PDT

Closed Phase 0 verification. Re-read the Phase 0 directive and exit signal in
`roadmap/README.md`, re-ran docs/code drift scans, and treated the only
production-shaped gap found (`onSleep` idle grace) as task 21 before marking
verification complete. Remaining scan hits are narrative or future-facing docs:
the historia port sequencing proof, a URL-service authoring example that says
"stub" as an operator implementation option, the legacy wake-reason note, and
Tigris wording about pre-finalize bundle bytes not yet being referenced.

Focused package checks and builds for the Phase 0 areas pass. Root
`pnpm typecheck` is still red on the pre-existing billing-mock example
`eventId` error; that is now the first Phase 1 task under the local Mac build
directive.
