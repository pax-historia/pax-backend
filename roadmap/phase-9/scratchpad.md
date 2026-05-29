# Phase 9 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-29 03:51 PDT

Opened Phase 9 after Phase 8 completed locally. The directive is to
re-bootstrap the three Fly apps on the new Broker/Runner shard image, with no
per-shard RocksDB volume, then prove roughly 100 concurrent games for 30 minutes
under both no-fault and shard-death-every-five-minutes profiles with all
guarantee oracles green and at least one continuous placement-through-URL-service
trace exemplar visible.

First task is a surface audit before touching Fly state: re-read the deploy and
bootstrap scripts, `fly.*.toml`, the observability pipeline, Fly-proxy WebSocket
machine-routing assumptions, and the scenario/scale commands that will produce
the 100-game proof.

## 2026-05-29 04:05 PDT

Surface audit is complete and produced the concrete Phase 9 task list in
`task-tracker.md`.

Findings:

- `scripts/bootstrap/spin-up.sh` still matches the new architecture shape:
  three Fly apps, one Tigris bucket, one Upstash Redis directory, no Postgres,
  and no shard volume provisioning. It syncs Better Stack credentials from
  Infisical when present. `scripts/bootstrap/tear-down.sh` remains hard-coded;
  do not touch its allowlist.
- `fly.shards.toml` and `scripts/fly/scale-shards.sh` removed the old RocksDB
  mount path and use Broker env (`PAX_BROKER_BIND`, `PAX_BROKER_WS_PATH`,
  `PAX_RUNNER_KIND`). `scale-shards.sh` is still scale-up-only.
- The existing scale plan is still named Phase 5. The 100-game rung exists, but
  it is single-shard; Phase 9 should add/adapt a topology-specific 100-game
  multi-shard rung so the proof exercises the new Fly machine-routing path.
- The important transport gap is WS machine routing. The router currently
  appends `fly-prefer-instance-id` / `fly-force-instance-id` as query params.
  Fly's current docs describe those as request headers, and browser WebSocket
  clients cannot set custom headers. The documented server-side path is
  `fly-replay: instance=<machine>`, with the caveat that the replaying instance
  must not negotiate the WebSocket upgrade itself:
  https://fly.io/docs/networking/dynamic-request-routing/
  https://fly.io/docs/networking/services/
  https://fly.io/docs/blueprints/sticky-sessions/

Decision: before deploying the topology proof, add or validate a Broker-side
Fly-Replay handoff for wrong-shard WS upgrade requests and make the router
return the public shard app hostname for Fly proof URLs. Private `.internal`
Broker URLs are still useful for admin-to-Broker calls but do not validate the
public Fly-proxy WS path required by the Phase 9 exit signal.

## 2026-05-29 04:17 PDT

Implemented the Fly-Replay transport shape before deploy:

- `ShardBrokerInfo` now has optional `publicUrl`. Broker shard rows keep
  `url` as the private/admin Broker URL and add `broker.publicUrl` for public
  client WebSocket placement.
- The placement router builds `webSocketUrl` from `broker.publicUrl` when
  present and no longer appends instance-routing query params.
- Broker upgrade handling now checks a signed placement token before calling
  `wss.handleUpgrade`. If the token targets another shard and Redis
  `active_games:<gameId>` has that shard's `flyMachineId`, the non-target
  Broker responds with `Fly-Replay: instance=<machine>` and does not negotiate
  the WebSocket upgrade.
- `scripts/fly/scale-shards.sh` now sets each machine's private
  `PAX_SHARD_PUBLIC_URL` for admin calls and public
  `PAX_SHARD_PUBLIC_WS_URL=https://pax-backend-shards.fly.dev` for placement.

Verification so far: `cargo fmt --check`, `cargo check --manifest-path
orchestration/placement-router/Cargo.toml`, `pnpm typecheck`,
`git diff --check`, and local `pnpm smoke` all passed. The Phase 9 task remains
open until deployed Fly machines prove the public URL and replay handoff.

## 2026-05-29 04:22 PDT

Added the Phase 9 topology scale plan at
`testing/scale-ladders/phase9-topology.mts`. It declares ladder
`phase-9-topology-proof` with one rung:

- `100g-3shards-30m-topology`
- 100 concurrent games
- three shard machines
- 30-minute target duration
- two-minute ramp
- one session per game
- one-minute heartbeat spread over 30 seconds
- nemeses: `no-faults`, `shard-death-every-5m`

The three-shard shape is intentional: Phase 9 is a topology proof, not a
single-machine smoke, and the public Fly-Replay WebSocket path only becomes
meaningful when more than one shard machine can receive an initial upgrade.

Validation: scenario-runner's `loadScaleLadderPlan` successfully loaded the new
plan, `pnpm --filter @pax-backend/scenario-runner check-types` passed, and
`git diff --check` passed.

## 2026-05-29 03:53 PDT

Bootstrap and deploy health are complete for the Phase 9 Fly topology:

- `scripts/bootstrap/spin-up.sh` converged idempotently against the existing
  `pax-backend` Fly org, Tigris bucket, Upstash Redis directory, and Infisical
  `dev` project. Secret drift verification passed, including Better Stack
  source token and ingest host checks, without printing secret values.
- Built and deployed the control image
  `pax-backend-control:deployment-01KSSN2QRCRXGV9YDWDTHP9XQM`; both control
  machines are started with all three Fly checks passing.
- Built and deployed the driver image
  `pax-backend-driver:deployment-01KSSN6HB5G6K59GKJF8Y8QRAH`. Driver machines
  remain stopped until the scenario proof run needs them.
- Built the shard image
  `pax-backend-shards:deployment-01KSSN7ZQ6FNS45WJ7EBZ47DTF`. `fly deploy`
  could not replace the old stopped shard machines non-interactively because
  they still carried Phase 5 RocksDB volumes, so created three fresh explicit
  Machines-config Broker machines instead, then destroyed the ten stale
  volume-backed machines and their obsolete `pax_backend_rocks` volumes. The
  shard app now has exactly three started machines, no volumes, service port
  7700, and all TCP checks passing.
- Live length-only env checks on one control machine and one shard machine show
  `BETTERSTACK_SOURCE_TOKEN`, `BETTERSTACK_INGESTING_HOST`, `REDIS_URL`, and
  `AWS_ACCESS_KEY_ID` are present. Values were not printed.
- The first shard start surfaced `PAX_BROKER_BIND=:::7700` as invalid for the
  Broker bind parser. Fixed Fly config and `scale-shards.sh` to use
  `0.0.0.0:7700`, updated the live shard machines, and verified public
  `https://pax-backend-shards.fly.dev/healthz` returns healthy Broker capacity
  with private per-machine admin URLs.

## 2026-05-29 04:31 PDT

Fly-proxy WebSocket routing proof is complete.

The proof harness at `scripts/fly/prove-ws-routing.mts` seeds a one-off game
through the control-plane admin API, asks the public placement router for a
socket URL, checks the three shard machines with forced health requests, opens a
normal public WS, then opens a second WS forced to a non-target machine. The
second request validates that the non-target Broker emits `connection.replay`
and the client still receives `ready` from the target Broker.

Evidence from the final proof in `var/phase-9/ws-routing-proof.json`:

- game: `phase9-ws-mpquhwsj`
- trace: `b540aa83108b4a4589ea628f243f6b45`
- target shard: `shard-fly-iad-1`
- target machine: `185906da630218`
- forced non-target machine: `781245db5e5908`
- websocket host/path: `pax-backend-shards.fly.dev` / `/gateway`
- placement token present: true
- instance query params present: false
- normal WS ready: true
- forced wrong-machine replay ready: true

Shard image for the final proof:
`registry.fly.io/pax-backend-shards:deployment-runner-handlers-20260529043314`.
Machine list after deployment showed exactly three no-volume machines, all on
that image and all with checks passing.

Shard history confirms the path: machine `781245db5e5908` emitted
`connection.replay` to target Fly machine `185906da630218`, and target machine
`185906da630218` opened both sessions under the same trace ID.

Implementation adjustment from the first failed proof: synthetic
`fly-force-instance-id` / `fly-prefer-instance-id` headers used by the proof
must not survive the replay. The Broker now uses Fly's replay JSON format to
delete those headers when present, while production browser connections still
use the plain `Fly-Replay: instance=<machine>` response because browsers do not
set either header. Broker active-game refreshes also preserve `flyMachineId` so
subsequent wrong-machine arrivals remain replayable.

Operational note: running plain `fly deploy` against the shard app created two
unwanted Fly Launch `app` machines because the real Phase 9 shard machines are
explicit Machines-config instances. Destroyed those temporary machines and
updated the three intended machines directly. Future shard image refreshes
should build/push the image separately, then run `fly machine update` for:
`185906da630218`, `781245db5e5908`, and `d8d04d6b232e38`.

One substrate issue surfaced before the 100-game proof: a bundle that omits a
lifecycle handler (for example `onSleep`) caused the child runner wrapper to
wait forever because the in-process Runner returned without emitting
`handler.complete`. The fix is committed separately so missing optional
handlers complete as no-ops in both `ivm` and `noivm` runners.

The final deployed proof also validated that fix after the 60-second idle
sleep grace: target machine `185906da630218` recorded `onSleep.sent`,
`handler.complete` for `onSleep` in 0.24ms, `state.flush.plannedTransition`,
and `game.released` with `checkpointOk=true` for `phase9-ws-mpquhwsj`.

## 2026-05-29 04:43 PDT

Started the Phase 9 topology scale proof from Fly driver machine
`1854539b257768`.

Preflight:

- shard app has exactly three no-volume machines:
  `185906da630218`, `781245db5e5908`, and `d8d04d6b232e38`
- all three shard checks pass on image
  `registry.fly.io/pax-backend-shards:deployment-ipv6-bind-20260529043955`
- control/router/gateway internal health checks pass from the driver
- driver-to-shard private metrics now works for all three
  `*.vm.pax-backend-shards.internal:7700/metrics` endpoints

The private metrics preflight exposed one topology issue before launch:
`fly machine update --image` preserved the old per-machine
`PAX_BROKER_BIND=0.0.0.0:7700`, so the Broker was healthy through the Fly
service but unreachable over machine-private IPv6. The Broker now accepts
bracketed IPv6 binds, shard config uses `PAX_BROKER_BIND=[::]:7700`, and the
live machines were updated with that env value.

Detached run:

- remote dir: `/data/phase-9/topology/ivm-20260529T114309Z`
- driver PID: `925`
- command: `phase9-topology.mts` rung `100g-3shards-30m-topology`
- runtime: `ivm`
- oracles: `scenario`
- control/router/gateway URLs: Fly-internal control app ports
- broker metrics: one private URL per shard machine
- history profile: `PAX_SCENARIO_HISTORY_PROFILE=scale`

The scale plan contains both Phase 9 cases. It runs `no-faults` first, then
`shard-death-every-5m`; Task 5 can close after the first case result is green,
and Task 6 can close if the second case also passes. Initial `/admin/shards`
from the driver showed active games already distributed evenly, two per shard
at the first check.

## 2026-05-29 05:26 PDT

The first topology run at
`/data/phase-9/topology/ivm-20260529T114309Z` was stopped after it proved the
no-fault sustained window but before it could become Task 5 evidence. It opened
100 games across all three shards, held `send-json` for 1,770,375 ms, closed
100 sessions normally with code `1000` / `scenarioComplete`, and had zero
workload session errors. The final workload phase then failed because
`expect-history-events` polled the control-plane-local `/admin/history` file,
which does not contain Broker shard history on Fly until the post-workload
Tigris archive append runs.

Two fixes were committed before rerunning:

- `b45a512` changes planned Broker drain to match
  `docs-next/subsystems/redeploy-and-drain.md`: it stops accepting new wakes
  but does not sleep active connected games. This prevents the
  `shard-death-every-5m` drain profile from closing steady-state sockets.
- `fc5de53` and `c76aba4` let scale runs select nemeses and default scale-profile
  live history checks to delayed mode, so post-run archive/control-plane history
  append feeds the replay/oracle step instead of a premature control-plane-only
  poll.

Built and deployed patched images:

- shards:
  `registry.fly.io/pax-backend-shards:deployment-planned-drain-20260529121004`
- driver:
  `registry.fly.io/pax-backend-driver:deployment-scale-history-delay-20260529122225`

All three shard machines and the active driver machine passed checks after the
image updates. Private shard metrics were reachable from the driver, and
`/admin/shards` showed all three shards healthy/accepting with zero active
games before relaunch.

Fresh detached run:

- remote dir: `/data/phase-9/topology/ivm-20260529T122658Z`
- driver PID: `806`
- monitor PID: `807`
- command: `phase9-topology.mts` rung `100g-3shards-30m-topology`
- runtime: `ivm`
- oracles: `scenario`
- history profile: `PAX_SCENARIO_HISTORY_PROFILE=scale`
- live history wait: `PAX_SCENARIO_EXPECT_HISTORY_MODE=delay`

Initial status line at `20260529T122658Z` showed the run alive with zero
failures; the no-fault case had started placement and reached 13 placements by
the first spot check.

## 2026-05-29 06:01 PDT

Task 5 is complete. The patched topology run at
`/data/phase-9/topology/ivm-20260529T122658Z` wrote a passing no-fault result
before advancing into the shard-death case.

No-fault evidence:

- result:
  `100g-3shards-30m-topology/ivm-chat-steady-state-100g-3shards-30m-topology-no-faults.result.json`
- history:
  `100g-3shards-30m-topology/ivm-chat-steady-state-100g-3shards-30m-topology-no-faults.history.jsonl`
- 100 placements across all three Phase 9 shards:
  `shard-fly-iad-1=34`, `shard-fly-iad-2=33`, `shard-fly-iad-3=33`
- all workload phases completed:
  `seed-fixtures`, `open-sessions`, `send-json`, `close-sessions`, and
  `expect-history-events`
- `send-json` held for 1,770,276 ms, which covers the intended 30-minute
  topology window with the existing ceil/count behavior
- all 100 sessions closed normally with code `1000` and reason
  `scenarioComplete`
- no workload phase failures, no workload session errors, no history parse
  errors, and all scenario oracles passed

The same run is still active for Task 6. It started
`shard-death-every-5m` immediately after the no-fault result and had already
placed early games evenly across the three shards at the first post-advance
artifact pull.

## 2026-05-29 06:17 PDT

Task 6 is in progress on the same detached run. The shard-death case completed
its 100-game placement ramp at `2026-05-29T13:02:35Z` and entered the
30-minute `send-json` hold. The first three nemesis cycles drained
`shard-fly-iad-1`, `shard-fly-iad-2`, then `shard-fly-iad-3`; each recorded a
matching `nemesis.kill-shard.replacement-ready` event 60 seconds later. Through
the third replacement, the workload history still had zero phase failures,
zero session errors, and zero non-final session closes.

Prepared Task 7 without touching the active proof driver: committed
`8203c4d` so future live scenario-runner placements propagate a generated
W3C trace context into the router, built and pushed driver image
`registry.fly.io/pax-backend-driver:deployment-trace-context-20260529130302`,
and updated only the stopped driver machine `d895e95fe09768` to that image.
The active driver machine `1854539b257768` remains on the topology-proof image
until the run finishes.

## 2026-05-29 06:36 PDT

Task 6 is complete. The topology run exited `0` after both Phase 9 cases passed.
Final local artifacts were pulled from driver machine `1854539b257768` into
`var/phase-9/topology/ivm-20260529T122658Z`, and the full summary gate passed
with `summary.gates_ok=true`.

Final topology proof:

- run dir: `/data/phase-9/topology/ivm-20260529T122658Z`
- local summary: `var/phase-9/topology/ivm-20260529T122658Z/summary.final.json`
- scale rung: `100g-3shards-30m-topology`
- cases: `no-faults` and `shard-death-every-5m`
- run exit code: `0`
- both case result files present and passed
- each case placed 100 games across the same three shards:
  `shard-fly-iad-1=34`, `shard-fly-iad-2=33`, `shard-fly-iad-3=33`
- no-fault `send-json`: 1,770,276 ms
- shard-death `send-json`: 1,770,280 ms
- shard-death injected six drain cycles and recorded six matching
  replacement-ready events during the hold
- both cases completed `seed-fixtures`, `open-sessions`, `send-json`,
  `close-sessions`, and `expect-history-events`
- both cases closed all 100 sessions normally with code `1000` and reason
  `scenarioComplete`
- no workload phase failures, no workload session errors, no history parse
  errors, no capacity warnings, no budget rejects, and no failing scenario
  oracles

## 2026-05-29 06:56 PDT

Task 7 is complete. The first trace-exemplar attempt proved placement/session
trace propagation but failed the URL-service oracle because the deployed API
gateway rejected Broker invokes where `runId` was protocol-null before emitting
a wire record. Commit `1206514` changed the gateway parser to accept nullable
`runId` and nullable/omitted idempotency keys, matching the shared protocol.
The control app was redeployed as
`registry.fly.io/pax-backend-control:deployment-gateway-null-runid-20260529135000`
with digest
`sha256:40e432ed2a7c8c44ec2836716f4fa4853cb69552ced1a3537264b829644f6d2e`;
both control machines passed Fly checks. A live Broker-shaped probe with
`runId: null` returned a gateway `wireRecord`.

Focused trace run:

- run ID: `phase9-trace-20260529T135059Z`
- remote dir: `/data/phase-9/trace/phase9-trace-20260529T135059Z`
- local dir: `var/phase-9/trace/phase9-trace-20260529T135059Z`
- driver machine: `d895e95fe09768`
- scenario: `api-partition-adversarial`
- trace ID: `f40d0b0e10154668cf9e84793f3e8c25`
- exit status: `0`

The scenario result passed `G5_faithful_api_dispatch`,
`G8_crash_blast_radius`, `G14_history_completeness`, and
`G0_api_partition_adversarial`. The pulled history has one
`placement.accepted`, one `session.opened`, 40 `api.invoke.request`, 40
`api.invoke.wire`, 40 `api.invoke.response`, and one `session.closed` under the
same trace ID. The API partition produced eight typed provider failures with
wire `statusCode=0`, then recovered to 32 successful `statusCode=200`
responses after restore.

Better Stack lookup used the newly stored Infisical API token to create
short-lived ClickHouse connections, query the source, and then delete both
temporary connections. No query credentials or source tokens were printed.
Evidence in `t527589_pax_backend_v1_soak_2_logs`:

- 229 rows containing trace `f40d0b0e10154668cf9e84793f3e8c25`
- history events: 40 `api.invoke.request`, 40 `api.invoke.wire`, 40
  `api.invoke.response`, one `session.opened`, and one `session.closed`
- OTLP names in the same trace: one `router.placement`, 40 `gateway.invoke`,
  and 32 `urlsvc.mock-ai.v1.invoke`

The continuous placement-through-URL-service exemplar is visible in the
production observability sink.
