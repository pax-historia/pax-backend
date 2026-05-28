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
3. `./scripts/bootstrap/spin-up.sh` has provisioned:
   - Fly apps: `pax-backend-shards`, `pax-backend-control`, `pax-backend-driver`
   - Starter Fly Volume `pax_backend_rocks` (5 GB) on `pax-backend-shards`
   - Tigris bucket `pax-backend-blobs` (AWS_* in Infisical, synced to all three apps)
   - Upstash Redis `pax-backend-directory` (REDIS_URL in Infisical, synced to
     `pax-backend-shards` + `pax-backend-control`)
   - `FLY_API_TOKEN` (org-scoped, 60-day expiry) synced to control + driver
   - `PAX_JWT_SECRET` (HS256, 64 bytes) synced to control + shards

If you need to start over from a clean slate:
`PAX_BACKEND_TEARDOWN_CONFIRM=yes ./scripts/bootstrap/tear-down.sh` then
`./scripts/bootstrap/spin-up.sh`. Infisical secret values survive teardown
by design.

## Zone index — where does it run?

The repo is six zones. Each zone answers **"where does this code run?"**
mechanically; the layout itself enforces convention by absence of
wrong-place (there is no `runtime/billing/` folder, so no one can put
billing code there without obvious deliberation — no CI grep needed).

| Zone | What runs there | Deploys to |
|---|---|---|
| `runtime/` | Rivet engine, parent actor, child runners, shard image | `pax-backend-shards` |
| `orchestration/` | Placement router, control plane, API gateway, reference URL services | `pax-backend-control` |
| `sdk/` | Typed creator surface, harness, bundle CLI | npm |
| `testing/` | Scenario-runner, scenarios, nemeses, oracle library, smoke bot | `pax-backend-driver` (on demand) |
| `examples/` | Reference creator bundles, reference URL services | never deployed; pure demos |
| `shared/` | Cross-zone wire-contract code (`@pax-backend/ipc-protocol`) | imported by ≥2 zones |
| `vendor/` | Vendored Rivet (read-only) | rebuilt into the shard image |

`docs/` and `scripts/` are cross-zone helpers and live at the top level.

**Multi-zone PRs are encouraged.** A feature that spans an admin endpoint
in `orchestration/control-plane/admin/games/flip-bundle.ts`, a manifest
type in `sdk/runtime-sdk/src/manifest.ts`, an oracle in
`testing/oracles-lib/src/guarantees/bundle-compatibility-safety.ts`, and a
demo bundle in `examples/bundles/hello-bundle-flip/` is ONE PR — the same
way a Next.js feature spans `app/api/foo/route.ts` and `app/foo/page.tsx`
in one commit. The zones exist for **discovery and deploy-token scoping**,
not for review restriction.

The full mental model is three sentences in [`docs/dev/layout.md`](docs/dev/layout.md).

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

`scripts/bootstrap/tear-down.sh` hard-codes the three apps + the Tigris
bucket. If you ever feel the urge to generalize it or accept a flag, **stop
and report**. The allowlist exists to make destruction reviewable in
`git diff`.
