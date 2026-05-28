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
