# `runtime/` — what runs INSIDE a shard

**Deploys to `pax-backend-shards`.** One image per release, rolled across all
shard machines (canary one, watch metrics 10–30 minutes, rolling
drain-and-replace — see [redeploy runbook](../docs/ops/redeploy-runbook.md)).

See the [plan](../README.md) §"Repo shape (proposed)" for the full layout
rationale, §"Trust model" for who is allowed to talk to whom, and
§"Lifecycle hooks", §"Storage tiers", §"Communication channels" for what
this zone has to implement.

## Contents

| Path | What it is |
|---|---|
| `shard-image/` | Multi-stage Dockerfile that bundles vendored Rivet + parent + child runners + IPC schema. |
| `parent-actor/` | Platform-trusted RivetKit actor. WS lifecycle, sessions, compute-plane quotas, IPC broker. |
| `child-runner-ivm/` | Default v1 untrusted-JS runner: `isolated-vm` inside a `node child_process`. |
| `child-runner-noivm/` | Alternate runner for the no-ivm conformance gate; CI runs this every release. |

The shared parent↔child wire contract is in
[`shared/ipc-protocol/`](../shared/ipc-protocol/) — it's used by both the
parent and the children and by the SDK that creators install, so it doesn't
live in this zone.

## Sub-layout convention (kind-folders)

Each package's `src/` is organized by **kind of thing**, one obvious folder
per kind:

```
parent-actor/src/
  lifecycle/      # one file per lifecycle hook (mirrors README §Lifecycle hooks)
                  #   onWake.ts, onSleep.ts, onPlayerConnect.ts, ...
  ipc/            # one file per IPC channel
                  #   wsSend.ts, stateRead.ts, stateWrite.ts, ...
  budgets/        # one file per compute-plane budget
                  #   cpu-ms-per-tick.ts, memory-bytes.ts, bandwidth.ts, ...
  sessions/       # session generation, tracking, eviction
  parent.mts      # entrypoint
```

**Soft rules:**

- **One-file-per-kind is a target, not dogma.** Group small siblings (e.g.,
  `state.read`/`state.write`/`state.flush` can share `state.ts` since they
  share buffer logic). The rule fires when a kind exceeds ~30 lines of
  distinct logic.
- **`_internal/` is the standardized escape hatch** for zone-local shared
  code that doesn't belong under a kind-folder. Use sparingly.
- **No pre-created empty kind-folders.** They get created when their first
  file lands. The convention is documented; the filesystem reflects what
  exists.

Smoke today is intentionally lean: `parent-actor/src/parent.mts` is one
file. The kind-folders appear as the substrate grows (M2 will add
`api-gateway/` interactions and a budgets file; M3 adds the blob tier with
its own ipc files).
