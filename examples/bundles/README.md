# `examples/bundles/` — first-party hello-world creator bundles

One bundle per substrate feature. Each is the **minimal** demonstration
of one or two channels — not a real game. See [`../README.md`](../README.md)
for the broader rules about the `examples/` zone.

| Bundle | What it exercises | Status |
|---|---|---|
| `hello-ws-echo/` | The WS tunnel, idempotency keys, `sessionId` stability. Echoes every `onPlayerMessage` body back via `c.ws.send`. The vertical smoke loads this. | shipped |
| `hello-blob-rw/` | `c.blob` durability. Reads on `onWake`, writes compact message history, logs via `c.log.emit`. | source added (untested) |
| `hello-state-rw/` | `c.state` durability with explicit `c.state.flush()` after each write. | source added (untested) |
| `hello-ai-call/` | The API gateway + context envelope + wire-grain recording end-to-end. Invokes `c.api.invoke('mock-ai.v1', ...)` per connected player message. The URL service sees the `connectedSessions` snapshot. | source added (untested) |
| `hello-multifeature/` | WS, logs, metrics, players, compute budget, state, blob, deterministic time/RNG, lifecycle, capacity warnings, and `c.api.invoke('mock-ai.v1', ...)` in one readable integration bundle. | source added (untested) |

## Per-bundle layout

```
<bundle-name>/
  package.json
  tsconfig.json
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
