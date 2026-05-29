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
