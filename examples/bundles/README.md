# `examples/bundles/` — first-party creator bundles

Small hello bundles demonstrate individual substrate features; larger proof
bundles live here when they exercise the creator contract end-to-end. See
[`../README.md`](../README.md) for the broader rules about the `examples/`
zone.

| Bundle | What it exercises | Status |
|---|---|---|
| `budget-edge-probe/` | Adversarial compute-budget probe for CPU timeout, WS rate, bandwidth, state size, blob key count, and API rate edges. | scenario guard |
| `hello-ws-echo/` | The WS tunnel, idempotency keys, `sessionId` stability. Echoes every `onPlayerMessage` body back via `c.ws.send`. The vertical smoke loads this. | shipped |
| `hello-blob-rw/` | The keyed `c.blob` namespace. Writes the current JSON snapshot under `current.json` with `c.blob.put`, reads it back with `c.blob.get`, and exercises namespace durability plus the per-game key/byte caps. | source added (untested) |
| `hello-state-rw/` | The managed `c.state` tier; reads/writes the whole object and includes an explicit `await c.state.flush()` before a crash-test point. Exercises Tigris-canonical state and the flush-window guarantee. | source added (untested) |
| `hello-ai-call/` | The API gateway + context envelope + wire-grain recording end-to-end. Invokes `c.api.invoke('mock-ai.v1', ...)` per connected player message. The URL service sees the `connectedSessions` snapshot. | source added (untested) |
| `hello-multifeature/` | WS, logs, metrics, players, compute budget, state, blob, deterministic time/RNG, lifecycle, capacity warnings, and `c.api.invoke('mock-ai.v1', ...)` in one readable integration bundle. | source added (untested) |
| `historia-default/` | The Pax-historia proof bundle. Ports the game-session modules, workflow runtime, state/blob migrations, URL-service calls, routing, hydration, policy gates, and ten-scenario proof suite. | Phase 3 proof complete |
| `hostile-ws-target/` | Adversarial bundle that tries to send to a player without a connected session; used by the Phase 4 compromised-bundle scenario. | scenario guard |

## Per-bundle layout

```
<bundle-name>/
  package.json
  tsconfig.json
  manifest.ts        # optional; larger bundles keep the manifest separate
  src/
    index.mts         # the source — ESM, imports defineBundle from SDK
    ambient.d.ts      # declares the runtime-injected globals (__pax_install)
  dist/               # esbuild output (gitignored); created by build-bundles.sh
    bundle.js         # the IIFE script the substrate ships into ivm
```

Build via `pnpm build:bundles` from the repo root, or
`scripts/build/build-bundles.sh <bundle-name>` for one bundle.

## When to add a bundle here vs. somewhere else

Add it here if it exists primarily for **humans to read** as a
demonstration of the substrate contract. The smoke bot happens to load
`hello-ws-echo` too, but its primary purpose is documentation.

If a "bundle" is actually a scenario whose primary purpose is the
scenario-runner exercising a substrate guarantee, it lives under
[`testing/scenarios/<scenario>/bundle/`](../../testing/scenarios/)
instead.
