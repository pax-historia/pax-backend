# `examples/` — pure demos, never deployed

Reference creator bundles and reference URL services that exist to
demonstrate the contract — not to run on any production shard or driver.
The runtime-side `examples/bundles/hello-ws-echo` doubles as the bundle
that the smoke loop ships into isolated-vm.

The line between this zone and `testing/`:

- A package belongs in `examples/` if a human READS it to understand the
  substrate contract.
- A package belongs in `testing/` if the scenario-runner EXECUTES it to
  exercise a substrate guarantee.

The hello bundle does both — it's a creator-facing demo of the minimum
viable bundle, and the smoke-bot reaches in to load it. That's fine; the
classification is on intent ("for humans to read"), not on whether other
code happens to consume it.

## Contents

| Path | What it is |
|---|---|
| `bundles/<name>/` | Creator-facing example bundles. One folder per bundle. Each is the *minimal* demonstration of one or two channels — not a real game. The README's "hello-world creator bundles" list lives here. |
| `url-services/<service>/` | Operator-facing reference URL services. Currently includes `billing-mock.v1`, a *reference* implementation that demonstrates one way to layer credit/refund/spectator policy on top of session observability — explicitly NOT part of the substrate's contract. |

## Bundles currently shipped

| Bundle | What it demonstrates |
|---|---|
| `hello-ws-echo` | `onWake` (cold-start), `onPlayerConnect` (sessionId stability), `onPlayerMessage` (idempotency seq), `c.ws.send` (WS transport back), `c.log.emit` (history). Echoes every player message back. The smoke loop loads this. |
| `hello-blob-rw` | `c.blob` durability |
| `hello-state-rw` | `c.state` durability + `c.state.flush()` |
| `hello-ai-call` | `c.api.invoke('mock-ai.v1', ...)` + context envelope + wire-grain recording |
| `hello-multifeature` | WS, logs, metrics, players, compute budget, state, blob, deterministic time/RNG, lifecycle, capacity warnings, and `c.api.invoke('mock-ai.v1', ...)` in one readable bundle |

## Sub-layout convention

Each bundle is a small package: `package.json`, `src/index.mts` (the source
the creator writes), `src/ambient.d.ts` (declares the runtime-injected
globals like `__pax_install`). esbuild compiles `src/index.mts` →
`dist/bundle.js` (an IIFE that the substrate ships into `isolated-vm`).
Build via `pnpm build:bundles` from the repo root, or
`scripts/build/build-bundles.sh <bundle-name>` directly.

URL services have whatever internal layout makes sense for the service —
they're HTTP endpoints the operator wires into the gateway's
kindName→URL registry.
