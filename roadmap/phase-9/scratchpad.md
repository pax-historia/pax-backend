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
