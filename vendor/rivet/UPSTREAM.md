# Vendored Rivet — provenance and re-pin procedure

This directory is a **vendored copy** of the Rivet engine + RivetKit SDKs,
dropped into the `pax-backend` monorepo Google-style. Patches, reverts, and
history live in this repo's `git log` — there is no nested `.git`.

## Current pin

| Field | Value |
|---|---|
| **Source repo** | [pax-rivet-refactor](../../../pax-rivet-refactor/) (sibling) |
| **Source commit** | `bdfb9825cb9fcaefc8f1a2cbb8e2c510cacbcf2f` |
| **Source subject** | `executor-lanes: fuse keyed actor setup writes` |
| **Vendored on** | 2026-05-27 |
| **Upstream Rivet commit** | `cef217f6b5ecdb70bde9f64abc097b563cdbf0a1` (`docs: prep for site (#5096)`) |
| **Refactor commits on top of upstream** | ~100 commits (UPS lanes, Tunnel v2, Executor lanes, Routing Directory) |

## Why this pin

`bdfb982` is the most recent **smoke-validated** head of
pax-rivet-refactor at the time of vendoring:

- Probe `1779923625487-715` on image
  `fused-keyed-bdfb982-20260527160337@sha256:4e951bdffc3728cc56a9932c826ab318e9385db23c1fa3b8b415b27f7fe699ea`
  reached `500/500` ready with zero permanent setup failures in **10.5s**.
- Frame-age p99 at 500 worlds: **189ms**.
- Gateway open-ack slow samples: **0**.

The next commit (`cfd5611`, `gasoline: trim signal publish conflicts`) is
**unsmoked** as of the vendoring date. We will re-pin once that commit (or a
later one) has been smoke-validated in pax-rivet-refactor.

## Why pax-rivet-refactor and not upstream directly

The prior spikes (`pax-spike-fly`, `pax-sharded-spike`) hit hard ceilings
against upstream Rivet (chat N≈20–25 on Postgres, multi-second physics
broadcast tails, 17s shard-death p99) that the refactor cycle addressed via
the four subsystem rewrites above. The substrate inherits the fixed Rivet so
the workaround ledgers from the prior spikes can stay deleted.

## How this directory was created

```
cd pax-rivet-refactor
git archive bdfb982 vendor/rivet | tar -x --strip-components=2 \
  -C /Users/eli/Documents/GitHub/pax-backend/vendor/rivet
```

This pulls the exact tree at `bdfb982` (4570 tracked files, ~67 MB on disk),
excluding `node_modules/`, `target/`, `dist/`, and other build artifacts (the
root `.gitignore` covers `vendor/**` for these).

## Re-pinning

Bumps from pax-rivet-refactor must be deliberate. Do **not** pull upstream
Rivet directly into this repo — the refactor commits are non-optional.

Each re-pin is a single PR that touches **only** `vendor/rivet/` (and this
file) and updates the provenance block above. Steps:

```bash
# 1. Pick a new pin from pax-rivet-refactor (latest smoke-validated head)
cd pax-rivet-refactor && git log --oneline -10

# 2. Re-extract the tree
cd /Users/eli/Documents/GitHub/pax-backend
rm -rf vendor/rivet
mkdir -p vendor/rivet
cd /Users/eli/Documents/GitHub/pax-rivet-refactor
git archive <new-sha> vendor/rivet | tar -x --strip-components=2 \
  -C /Users/eli/Documents/GitHub/pax-backend/vendor/rivet

# 3. Update this file's provenance block

# 4. Wipe the engine binary cache (it's pinned by source SHA but be explicit)
rm -rf /Users/eli/Documents/GitHub/pax-backend/.cache/rivet-engine

# 5. Run scripts/build-engine.sh; expect a cold native build
#    (~2-5 min on a fast Apple-Silicon Mac)

# 6. Run scripts/local-up.sh && npm run smoke
```

A re-pin invalidates the local `.cache/rivet-engine/*` symlink and any Fly
Docker layer cache. Budget for a cold native build plus, when we deploy, a
~8 min Fly Depot rebuild.

## Local modifications

None as of the initial vendoring. If we ever do apply pax-backend-local
patches on top of the pax-rivet-refactor pin, they go here as a chronological
list with one line each linking to the commit. Patches that should live
upstream of pax-backend go in pax-rivet-refactor first.
