# `runtime/` — what runs INSIDE a shard

**Deploys to `pax-backend-shards`.** CI rejects PRs that touch both `runtime/**`
and `orchestration/**`; the Fly token scoped to this zone has no permission
to touch the control or driver apps.

See the [plan](../README.md) §"Repo shape (proposed)" for the full layout
rationale, §"Trust model" for who is allowed to talk to whom, and §"Lifecycle
hooks", §"Storage tiers", §"Communication channels" for what this zone has to
implement.

## Contents

| Path | What it is |
|---|---|
| `shard-image/` | Multi-stage Dockerfile that bundles vendored Rivet + parent + child runner; built once and rolled across all `pax-backend-shards` machines. |
| `parent-actor/` | Platform-trusted RivetKit actor. WS lifecycle, sessions, compute-plane quotas, IPC broker. |
| `child-runner-ivm/` | The default v1 untrusted-JS runner: `isolated-vm` inside a `node child_process`. |
| `child-runner-noivm/` | Alternate runner for the no-ivm conformance gate; CI runs this every release. |
| `ipc-protocol/` | Versioned IPC schema shared across parent / child / SDK. |
