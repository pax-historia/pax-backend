# `vendor/` — third-party source, vendored Google-style

The third-party source we depend on, dropped in directly so the parent
repo's `git log` is the history. There are no nested `.git` directories,
no submodules, no flake/lock indirection — just files we can read, patch
with regular commits, and `cargo build` / `pnpm install` against.

## Contents

| Path | What it is |
|---|---|
| `rivet/` | Vendored Rivet engine + RivetKit TypeScript packages at the [pax-rivet-refactor](../../pax-rivet-refactor/) pin. See [`rivet/UPSTREAM.md`](rivet/UPSTREAM.md) for the SHA, the rationale, the build expectations, and the re-pin procedure. |

## Why vendoring (and not a Cargo dep or git submodule)

Per the plan:

- **Patches, reverts, and history live in this repo's `git log`.** No
  upstream-fork / sync round trip; we own the source-of-truth for the
  exact bytes the substrate runs.
- **Re-pin is a single PR that touches only `vendor/`.** Reviewers see the
  diff against the previous pin directly. Subsystem-prefixed commits show
  what changed (`vendor-rivet: bump to <new-sha> (executor-lanes fix)`).
- **No external network at build time.** `cargo build -p rivet-engine`
  reads from this tree, not from crates.io for Rivet itself (the *other*
  crates Rivet pulls in are still fetched normally).
- **Sibling spike compatibility.** Both `pax-rocks-spike` and
  `pax-rivet-refactor` vendor the same way; tooling discipline transfers.

Build artifacts under `vendor/**` (`node_modules/`, `target/`, `dist/`,
`.next/`, `build/`) are gitignored. The committed tree is source only.

## Re-pinning procedure

Documented in [`rivet/UPSTREAM.md`](rivet/UPSTREAM.md). Summary:

1. Pick a new pax-rivet-refactor commit (latest smoke-validated head).
2. `rm -rf vendor/rivet && mkdir -p vendor/rivet`.
3. `cd ../pax-rivet-refactor && git archive <sha> vendor/rivet | tar -x
   --strip-components=2 -C /path/to/pax-backend/vendor/rivet`.
4. Update the provenance block in `rivet/UPSTREAM.md` (SHA, subject,
   date).
5. `rm -rf .cache/rivet-engine && ./scripts/build/build-engine.sh` —
   invalidates the binary cache and rebuilds natively.
6. `./scripts/dev/local-up.sh && pnpm smoke` — verifies the pin runs.

A re-pin is the only way `vendor/rivet/` should change. Local patches on
top of the pin go in pax-rivet-refactor first, then get pulled in via
re-pin.
