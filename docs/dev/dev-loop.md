# Dev loop — native macOS, no Docker on the hot path, no Fly in the loop

The acceptance gate for the substrate's first milestone is a single command:

```bash
./scripts/local-up.sh && pnpm smoke
```

passing on the developer's Mac. Fly deployment is a separate follow-up
milestone (M-fly). This doc records why and how.

## Why native and not Docker / not Fly

| Path | Cold rivet-engine build | Source |
|---|---|---|
| **Native macOS (Apple Silicon), profile=quick** | a few minutes (this repo) | scripts/build-engine.sh |
| Local Docker Desktop, linux/amd64 via Rosetta | **>20 min to 43 min** | [pax-rivet-refactor scratchpad](../../../pax-rivet-refactor/scratchpad.md), [pax-rocks-spike scratchpad](../../../pax-rocks-spike/scratchpad.md) |
| `fly deploy --local-only` (M5, Docker BuildKit Linux) | 8m44s – 18m53s | pax-rocks-spike scratchpad 2026-05-25 to 2026-05-27 |
| Fly Depot remote builder (BuildKit cache hot) | ~8–9 min | pax-rivet-refactor scratchpad 3300 |
| Smoke-only edits with engine layer cached | seconds | pax-rivet-refactor scratchpad 3173 |

Native skips the linux/amd64 cross-compile (Rosetta) and the Docker layer
churn entirely. The pax-rivet-refactor smoke harness was already designed for
native execution — it spawns rivet-engine via `spawn(ENGINE_BINARY, ...)` and
points `file_system.path` at a plain directory — but no spike actually wired
the full vertical loop locally because they all needed `performance-8x` Fly
machines for 500/1000-game gates. We have no such gate at smoke scale, so
we don't pay for Fly until M-fly.

## Stack topology (local)

```
+----------+      +-----------------+      +-------------+
| smoke-bot|----->| placement-router|<-----| local Redis |
+----------+      | Rust :9080      |      | (Docker)    |
      |           +-----------------+      +-------------+
      v                                         ^
+--------------+    +-----------------+         |
| rivet-engine |<---| parent-actor    |---------+ self-register
| Rust :6420   |    | Node + Runner   |
+--------------+    | + ivm child fork|
                    +-----------------+
                              |
                              v
                      var/history.jsonl
```

All five services run as native processes on this Mac. Redis runs in a
Docker container only because the Redis image is tiny and starts in <1s; the
substrate code itself does not touch Docker.

## Build cache strategy

The expensive thing is `rivet-engine`. `scripts/build-engine.sh` caches the
built binary at `.cache/rivet-engine/rivet-engine-<vendor-sha>-<lock-hash>`
and refuses to rebuild when the cache key still matches. A re-pin of
`vendor/rivet/` (recorded in `vendor/rivet/UPSTREAM.md`) is the only thing
that invalidates the cache.

The router is built with `cargo build --release` into the crate's local
`target/release/`. Cold a couple of minutes, incremental seconds.

`vendor/rivet/target/` is gitignored; do **not** delete it casually — that
re-triggers the multi-minute build. If you must (re-pin, etc.), run
`./scripts/build-engine.sh` and walk away while it does its thing.

## Inner-loop iteration costs

| Change | Action | Cost |
|---|---|---|
| Creator bundle (`tooling/bundles/hello-ws-echo/index.mjs`) | re-run `pnpm smoke` (parent re-reads bundle on each game create) | ms |
| Parent actor TS (`runtime/parent-actor/`) | `./scripts/local-down.sh && ./scripts/local-up.sh` | <1s + restart cost |
| Child runner TS (`runtime/child-runner-ivm/`) | parent forks fresh child per game, just re-run smoke | ms |
| IPC protocol (`runtime/ipc-protocol/`) | restart parent (consumers re-read on require) | <1s |
| Smoke bot | re-run `pnpm smoke` | ms |
| Router Rust | `./scripts/build-router.sh && ./scripts/local-down.sh && ./scripts/local-up.sh` | seconds incremental |
| `vendor/rivet/**` (re-pin) | `rm -rf .cache/rivet-engine && ./scripts/build-engine.sh` | minutes (cold native) |

## Anti-patterns (evidence-backed)

From the four spike scratchpads, **do not**:

- Use Docker Desktop for `rivet-engine` builds — measured at 43 min cold on this Mac shape.
- Use upstream `[profile.release]` (`lto=fat`, `codegen-units=1`) anywhere — SIGKILL at link on Depot and on local Docker, in every spike. The smoke uses `profile=quick`; the Fly image (when we build it) overrides via env to `LTO=off CU=16 JOBS=2`.
- Run the router as `cargo run` (debug) for any throughput probe — pax-sharded-spike saturated at 10k/50k games in 5-min ramp on a debug build.
- Workspace-wide `cargo check` — 17m33s cold. Always `cargo check -p <pkg>`.
- Trust prebuilt `releases.rivet.dev/rivet-engine-<target>` — version skew + segfault (pax-rocks-spike 2026-05-24).
- Re-pin `vendor/rivet/` casually — invalidates the binary cache and any Fly Docker layer cache.
- Local-only Docker builds while a sibling repo is also using `fly deploy --local-only` — builder contention.

## When to go to Fly (M-fly)

After the local smoke is green:

1. Build the shard image with the Fly Depot remote builder using BuildKit
   cache mounts (recipe from
   [pax-spike-fly/apps/engine/Dockerfile](../../../pax-spike-fly/apps/engine/Dockerfile)
   and
   [pax-rivet-refactor/smoke/rocks-physics/Dockerfile](../../../pax-rivet-refactor/smoke/rocks-physics/Dockerfile)) —
   never local Docker Desktop on this Mac.
2. Build-once-push-many: `fly deploy --build-only --push --image-label <label>`
   then `fly machine update --image <ref>` for swapping volume-pinned shards
   (the only pattern that actually works for `/data`-mounted machines per
   pax-sharded-spike 2026-05-25).
3. Driver / smoke-bot stays in its own Fly app (`pax-backend-driver`) so it
   never triggers a Rust rebuild.

The smoke-bot script is environment-portable (`PAX_ROUTER_URL` env var); the
same driver targets localhost or Fly without any code change.
