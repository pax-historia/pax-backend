# `.github/workflows/`

The minimal load-bearing CI for the substrate. Each workflow defends
something the layout itself cannot:

| Workflow | What it defends |
|---|---|
| `smoke.yml` | The vertical-smoke acceptance gate. Boots the local stack and runs `pnpm smoke` end-to-end. Red = no release. |
| `scenario-suite.yml` | The adversarial release gate. Runs `testing/scenarios` across `ivm` and `noivm` with every nemesis profile; uploads histories/results/logs on failure. |
| `typescript-strict.yml` | `tsc -b` across the workspace must pass with strict mode. Catches IPC envelope drift and bundle handler signature mistakes at compile time. |
| `deploy-shards.yml` | Deploys `runtime/` to `pax-backend-shards`. Uses `FLY_API_TOKEN_SHARDS` (scoped, no permission on control or driver apps). Triggered on `runtime/**` or `vendor/rivet/**` changes. |
| `deploy-control.yml` | Deploys `orchestration/` to `pax-backend-control`. Uses `FLY_API_TOKEN_CONTROL`. Triggered on `orchestration/**` changes. |
| `deploy-driver.yml` | Deploys `testing/` to `pax-backend-driver`. Uses `FLY_API_TOKEN_DRIVER`. Triggered on `testing/**` changes; usually only invoked when a scenario run is queued. |
| `publish-sdk.yml` | Publishes `sdk/` packages to npm. Uses `NPM_TOKEN`. Triggered on tagged releases under `sdk/**`. |

**What is deliberately NOT here.** No "rejects PRs that touch more than
one zone" check — multi-zone PRs are encouraged (a feature that adds an
admin endpoint, a manifest type, an oracle, and a demo bundle is ONE PR).
The zones exist for discovery and deploy-token scoping, not for review
restriction. See [`docs-next/vision/boundaries-and-layers.md`](../../docs-next/vision/boundaries-and-layers.md) for the
full mental model.

## Scoped tokens (Fly + npm)

Each deploy workflow uses a token scoped to its target. The bootstrap
script provisions and syncs these via Infisical; see
[`scripts/bootstrap/spin-up.sh`](../../scripts/bootstrap/spin-up.sh).

| Token | Repo secret name | Scope |
|---|---|---|
| Fly shards deploy | `FLY_API_TOKEN_SHARDS` | `pax-backend-shards` only |
| Fly control deploy | `FLY_API_TOKEN_CONTROL` | `pax-backend-control` only |
| Fly driver deploy | `FLY_API_TOKEN_DRIVER` | `pax-backend-driver` only |
| npm publish | `NPM_TOKEN` | `@pax-backend` org publish-only |

If you find yourself wanting one omnipotent token, **stop and report.**
Scoped tokens are the entire reason the deploy workflows are split.
