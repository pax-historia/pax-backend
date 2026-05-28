# Why: `isolated-vm` inside `child_process` per game

> Layer: **Why**

## Considered

Five sandboxing depths for untrusted creator JavaScript:

1. **Inline `vm` module.** Same Node process; no `isolated-vm`. Just
   `vm.Script` with a frozen global. No real isolation.
2. **`isolated-vm` in the parent process.** Each game's bundle runs in
   an isolate, but isolates share the parent's Node process. CPU/memory
   capped per isolate; one isolate crash takes down the parent.
3. **`isolated-vm` inside `child_process` per game.** Each game gets its
   own Node child; inside that child, the bundle runs in an isolated-vm
   isolate. Two layers of isolation.
4. **One Fly Machine per game.** Each game is its own Fly microVM with
   its own kernel namespace.
5. **WASM-based sandbox.** Bundle compiled to WASM; substrate runs it in
   wasmtime/wasmer.

We chose option 3 (`isolated-vm` inside `child_process`).

## Why we said no to options 1, 2, 4, 5

### Option 1 (inline `vm`)

`vm` module isolation is not a security boundary in Node. A bundle can
break out via prototype tricks, ambient global access, and other escape
routes that are accepted bugs in `vm`. No.

### Option 2 (`isolated-vm` in the parent process)

- **Crash blast radius is the shard.** One bundle's OOM kills the parent;
  the parent hosts ~100 games. Compromising guarantee #8 (crash blast
  radius = 1 game).
- **Memory enforcement is by isolate, not by OS.** `isolated-vm` advertises
  a memory cap but a determined adversary can sometimes spike past it
  briefly; with no OS-level cap there's no defense-in-depth.
- **CPU enforcement is best-effort.** Without a separate process, a
  runaway isolate burns CPU; the parent can't preempt it from outside.

### Option 4 (one Fly Machine per game)

- **No spike precedent at scale.** Sister spike `pax-spike-fly` proved
  the per-machine-per-game pattern hits engine-tunnel conflicts with
  Fly's `auto_stop_machines = "suspend"`. The architectural mismatch is
  documented in the prior plan.
- **Cost.** 1k concurrent games × Fly per-machine minimum costs is more
  than 10 shard machines hosting 100 games each.
- **Cold-start time.** Fly machine cold-start is 100s of ms minimum.
  Per-game-per-machine means every game-wake pays cold-start. Untenable
  for the gameplay UX.

### Option 5 (WASM)

- **Tooling immaturity.** Creator code is TypeScript today; the WASM
  toolchain for full TypeScript runtime is significantly less mature
  than `isolated-vm`.
- **Performance asymmetry.** V8-isolate-on-V8 has years of optimization.
  WASM-on-V8 layered on top of a Node host is harder to reason about and
  harder to profile.
- **No spike precedent.** Pax-historia's existing production pattern uses
  `isolated-vm`. Switching to WASM is a research project, not an
  engineering one.

## Why `isolated-vm` inside `child_process` per game

Two layers of isolation:

- **`child_process`**: each game runs as its own OS process. OS-level
  memory cap (`memoryLimit` flag on V8), CPU is naturally cgroup-bounded
  on Fly. Crash isolation is OS-level: one child OOM kills only that
  child; the parent restarts it.
- **`isolated-vm` inside the child**: the bundle runs inside an isolate
  in the child process. Even if the bundle escapes `isolated-vm`, it's
  inside a Node child with **no network sockets, no env vars, no
  filesystem access**.

The threat model becomes:

| Attack | Defense | Worst case |
|---|---|---|
| Bundle bug | `isolated-vm` syntactic isolation | Bundle author debugs their own code |
| `isolated-vm` escape | The child's own constraints (no net, no env, no fs) | Bundle now runs in a constrained Node process |
| Node child process escape | OS process isolation; cgroup limits | Requires Node zero-day; accepted floor |

Compromise of one child affects one game. Compromise of one parent
affects ~100 games (one shard). Compromise of the platform-trusted
orchestration tier is the substrate.

## Insurance: the runtime adapter is swappable

We ship `@pax-backend/runtime-ivm` as the v1 runner. The child's IPC
schema is independent of the inner runtime, so swapping to a future
no-ivm or successor runtime is a per-game flag, not a contract change.

A second child runner (`runtime/child-runner-noivm/`) exists from day one
as the conformance gate: every release runs the substrate's full scenario
suite against both runners. If the contract drifts between runners, the
no-ivm runner catches it.

## What would change our mind

We'd revisit if:

1. `isolated-vm`'s maintainer-risk story materializes — abandoned package,
   known unfixed security issues, V8-version mismatches with current Node.
2. A successor isolate library emerges (Bun isolates, a forked
   `isolated-vm` with better maintenance) with comparable or better
   isolation properties.
3. The compute envelope changes — e.g. we add server-side rendering of
   creator-written UI components that demands richer JS APIs than
   `isolated-vm` exposes cleanly.

We are deliberately not litigating sandboxing depth further in v1. The
goal of v1 is validating the substrate **shape** end-to-end; security
depth is a tunable we revisit once the shape is exercised.

## See also

- [`subsystems/child-runner-sandbox.md`](../subsystems/child-runner-sandbox.md)
  — implementation details
- [`vision/trust-model.md`](../vision/trust-model.md) — full trust positions
- [`vision/guarantees.md`](../vision/guarantees.md) #8 — crash blast radius
- [`docs/ops/sandboxing-current-pick.md`](../../docs/ops/sandboxing-current-pick.md)
  — the operational notes (pre-`docs-next/` material)
