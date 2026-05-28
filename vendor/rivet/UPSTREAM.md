# Vendored Rivet source

This directory will hold a **vendored copy** of the upstream Rivet engine +
RivetKit SDKs, dropped into the `pax-backend` monorepo (Google-style:
`third_party`-shaped). Patches, reverts, and history live in the parent
`pax-backend` repository's `git log`. There is no nested `.git`.

## Provenance

- **Upstream repo:** <https://github.com/rivet-dev/rivet>
- **Vendoring source:** the [pax-rivet-refactor](../../../pax-rivet-refactor/)
  sibling repo, which pins upstream at commit
  `cef217f6b5ecdb70bde9f64abc097b563cdbf0a1` and applies the
  UPS-lanes / Tunnel v2 / Executor lanes / Routing Directory rewrites.
- **Why pax-rivet-refactor and not upstream directly:** the prior spikes
  (`pax-spike-fly`, `pax-sharded-spike`) hit hard ceilings against upstream
  Rivet that the refactor cycle addressed. The substrate inherits the fixed
  Rivet so the workaround ledgers from the prior spikes can stay deleted.

## To vendor (step 2 of the plan's agent kickoff)

1. Pick a pin in [pax-rivet-refactor](../../../pax-rivet-refactor/) (latest
   acceptance-passing head).
2. Copy the contents of its `vendor/rivet/` into this directory, **excluding**
   `node_modules/`, `target/`, `dist/`, `build/`, `.next/`. The `.gitignore`
   at the repo root already excludes these for `vendor/**`.
3. Record the source commit hash + date here and in this file's "Provenance"
   block above.
4. Add a CI job that builds `vendor/rivet/engine/` cleanly from a cold cache;
   any patches that don't compile are caught immediately.

## Re-pinning

Bumps from pax-rivet-refactor must be deliberate. Do not pull upstream Rivet
directly into this repo — patches from the refactor cycle are non-optional.
Each re-pin is a single PR that touches **only** `vendor/rivet/` and updates
the provenance block above.

Stub.
