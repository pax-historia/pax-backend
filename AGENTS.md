# AGENTS.md — rules for autonomous work in pax-backend

You are building the **substrate** described in [README.md](README.md): a
general-purpose runtime that runs untrusted creator JavaScript, exposes a small
typed surface for talking to humans and to operator-defined external services,
and stays deliberately ignorant of everything billing-shaped. Read the README
in full before doing anything else — every guarantee, channel, and admin
endpoint in this repo exists in service of it.

This is **not** a spike. It ships in passes; each pass picks a slice of the
contract and lands it cleanly, with the scenario-runner gating CI.

## Sibling repos are READ-ONLY

The three sibling spikes that validated pieces of this architecture are
references, not source. Patterns are lifted; code is rewritten in-repo.

- [pax-spike-fly](../pax-spike-fly/) — one-Node-process-per-game on
  self-hosted Rivet at chat shape. Read for the JWT chokepoint pattern and
  isolated-vm-in-child sandboxing.
- [pax-sharded-spike](../pax-sharded-spike/) — placement-only router +
  per-shard RocksDB-on-Fly-Volume + Tigris blob. Read for the three-zone repo
  discipline and the `orchestration/router-placement/` shape (port verbatim,
  then add the `runtimeContractRequired` placement gate).
- [pax-rivet-refactor](../pax-rivet-refactor/) — fixes Rivet's UPS lanes,
  Tunnel v2, Executor lanes, and Routing Directory. The vendored Rivet in
  `vendor/rivet/` pins to its head; do not edit upstream Rivet here, pull
  changes from there.

Do not edit, commit, copy out of, symlink into, or run scripts inside any
sibling repo from this one.

## Bootstrap (already done by the time you read this)

1. The Fly org `pax-backend` exists with billing.
2. The Infisical project is linked via `.infisical.json` at the repo root.
3. `./scripts/spin-up.sh` has provisioned:
   - Fly apps: `pax-backend-shards`, `pax-backend-control`, `pax-backend-driver`
   - Starter Fly Volume `pax_backend_rocks` (5 GB) on `pax-backend-shards`
   - Tigris bucket `pax-backend-blobs` (AWS_* in Infisical, synced to all three apps)
   - Upstash Redis `pax-backend-directory` (REDIS_URL in Infisical, synced to
     `pax-backend-shards` + `pax-backend-control`)
   - `FLY_API_TOKEN` (org-scoped, 60-day expiry) synced to control + driver
   - `PAX_JWT_SECRET` (HS256, 64 bytes) synced to control + shards

If you need to start over from a clean slate:
`PAX_BACKEND_TEARDOWN_CONFIRM=yes ./scripts/tear-down.sh` then
`./scripts/spin-up.sh`. Infisical secret values survive teardown by design.

## Zone discipline (lifted from pax-sharded-spike)

The repo is five zones. CI rejects PRs that touch more than one zone. Each
zone has its own deploy workflow under `.github/workflows/` with its own
scoped Fly token.

| Zone | What it is | Deploys to |
|---|---|---|
| `runtime/` | What runs INSIDE a shard (Rivet engine, parent actor, child runners, IPC schema) | `pax-backend-shards` |
| `orchestration/` | What runs OUTSIDE shards (placement router, control plane, API gateway, reference URL services) | `pax-backend-control` |
| `sdk/` | The typed contract surface creators install (`@pax-backend/runtime-sdk`, harness) | npm |
| `tooling/` | Scenario-runner, scenarios, hello-world bundles, nemeses, oracles, bundle-tools | `pax-backend-driver` (when scenarios run) |
| `vendor/` | Vendored Rivet at the `pax-rivet-refactor` pin | rebuilt into shard image |

`docs/` and `scripts/` are cross-zone and exempt from the no-mixed-PR rule.

## Where to start

The plan's §"Agent kickoff instructions" enumerates twelve steps in order. Do
not skip ahead. Each step maps to one or more zones; finishing one step before
starting the next keeps the contract honest and the test surface small.

- **Step 1** is already done (this repo exists; org + apps + secrets are
  provisioned).
- **Step 2** is to vendor Rivet at the `pax-rivet-refactor` pin into
  `vendor/rivet/` and document the pin + bump procedure in
  `vendor/rivet/UPSTREAM.md`.
- **Step 3** is the placement router with the contract-version gate.
- **Steps 4–11** are the SDK, API gateway, compute-plane quotas, runtime,
  scenario-runner, hello-world bundles, and Fly footprint. **Step 12** is a
  reminder that sibling spikes are read-only references.

The substrate has no billing primitives by design. Any pressure to add
"Balance", "Reservation", or "DebitLogEntry" units is a sign you should stop
and re-read §"Why no billing primitives" of the README. The right move is
always to lean harder on session observability + the URL-service pattern.

## Refusing to extend the teardown allowlist

`scripts/tear-down.sh` hard-codes the three apps + the Tigris bucket. If you
ever feel the urge to generalize it or accept a flag, **stop and report**.
The allowlist exists to make destruction reviewable in `git diff`.
