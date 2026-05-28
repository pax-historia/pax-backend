# `tooling/` — the scenario-bundle harness and friends

The other half of the substrate. Adopts the
[scenario-bundle-harness](../../../.cursor/plans/scenario-bundle-harness_0348a2db.plan.md)
design wholesale (see [plan](../README.md) §"Testability — first-class, not
retrofitted").

## Contents

| Path | What it is |
|---|---|
| `scenario-runner/` | The harness binary. Three run modes (`load`, `property`, `fuzz`); replay mode for cross-version oracle re-runs; nemeses composed at run time. Deploys to `pax-backend-driver` machines on demand. |
| `scenarios/` | First-party scenarios: `chat-steady-state`, `compute-stress` (the renamed `billing-fuzz`, now focused on CPU/bandwidth/api-rate quotas), `shard-death-resilience`. |
| `bundles/` | First-party hello-world creator bundles, one per substrate feature: `hello-blob-rw`, `hello-state-rw`, `hello-ws-echo`, `hello-ai-call`, `hello-multifeature`. Each is the *minimal* end-to-end demonstration of one or two channels — not a real game. |
| `nemeses/` | Fault profiles, composed at scenario run time: `no-faults`, `shard-death-every-5m`, etc. |
| `oracles-lib/` | Reusable oracle helpers (**substrate-side only** — billing oracles live in operator URL-service test suites, not in this repo's release gate). |
| `bundle-tools/` | Bundle build / publish / fetch. Optional sha256 + signature helpers as defense-in-depth (off by default in v1; see [plan](../README.md) §"Bundle integrity & verification"). |
