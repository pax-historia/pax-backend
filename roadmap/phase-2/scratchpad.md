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
