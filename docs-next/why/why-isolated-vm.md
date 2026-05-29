# Why: `isolated-vm`, many isolates per Runner

> Layer: **Why**

## Considered

How to sandbox untrusted creator JavaScript, and at what process
granularity:

1. **Inline `vm` module.** Same process; `vm.Script` with a frozen global.
   No real isolation.
2. **`isolated-vm`, one isolate per game, many isolates per
   credential-less Runner process.** Each game runs in its own V8 isolate;
   a Runner hosts many; the Runner holds no credentials and no network.
3. **`isolated-vm`, one isolate per dedicated Node process per game.** Two
   layers, but a whole Node process per game.
4. **One Fly Machine per game.** Each game is its own microVM.
5. **WASM sandbox.** Bundle compiled to WASM, run in wasmtime/wasmer.

We chose option 2 (`isolated-vm`, many isolates per credential-less
Runner).

## Why we said no to the others

### Option 1 (inline `vm`)

`vm` isolation is not a security boundary in Node — prototype tricks and
ambient global access are accepted escape routes. No.

### Option 3 (one Node process per game)

Real isolation, but it duplicates the Node runtime per game (~36 MB
process vs ~1 MB isolate; ~97% of a typical game's footprint is duplicated
runtime) and pays a full Node boot on every wake. Collapsing per-game
processes into many isolates per Runner is a ~7-10× density win for
typical games. The process boundary we keep for crash containment is the
**Runner** (a pool), not one-per-game. See
[`why-broker-runner.md`](why-broker-runner.md).

### Option 4 (one Fly Machine per game)

- **No spike precedent at scale**, and per-machine cold start is 100s of
  ms — every wake would pay it. Untenable for gameplay UX.
- **Cost.** Per-machine-per-game minimums dwarf a shard hosting many
  games.

### Option 5 (WASM)

- **Tooling immaturity** for a full TypeScript runtime vs `isolated-vm`.
- **Performance asymmetry**: V8-isolate-on-V8 has years of optimization;
  WASM-on-V8-on-Node is harder to reason about and profile.
- **No precedent**: the production pattern is `isolated-vm`; WASM is a
  research project, not an engineering one.

## Why `isolated-vm`, many per credential-less Runner

Two layers of isolation, but the process boundary is shared across games:

- **The Runner process** gives a real OS boundary for native-crash
  containment and is scheduled across cores by the OS. It holds **no
  credentials and no network** — its only capability is "ask the Broker to
  act on a game I'm assigned."
- **The `isolated-vm` isolate** gives per-game isolation inside the
  Runner: separate V8 heaps, a per-isolate memory cap, no host-object
  leakage, and no visibility between co-tenant games. Even a bundle that
  escapes its isolate is inside a credential-less, network-less process.

The threat model:

| Attack | Defense | Worst case |
|---|---|---|
| Bundle bug | `isolated-vm` syntactic isolation | Author debugs their own code |
| `isolated-vm` escape | The Runner is credential-less, network-less | Reads/cross-contaminates the low-value content of co-tenant games on that one Runner; no credential, no money, no impersonation |
| Native Runner process escape | OS process isolation; cgroup limits | Requires a Node/V8 zero-day; accepted floor; still credential-less |

Compromise of one isolate affects one game's content; compromise of one
Runner affects its co-tenant games' content but **no credential**;
compromise of the Broker (credential holder) is the shard; compromise of
the platform-trusted orchestration tier is the substrate. The
credential-less Runner is what makes the escape case acceptable — it is
load-bearing and non-negotiable. See
[`vision/trust-model.md`](../vision/trust-model.md).

The cost of sharing the process across games is crash blast radius: a
native crash takes a Runner's `K` co-tenants. That is a per-preset dial
(`K = 1` recovers strict one-game blast radius), not a contract change —
see [`vision/guarantees.md`](../vision/guarantees.md) #8.

## Insurance: the runner is swappable

The `c.*` surface and the Broker bridge are independent of the inner
runtime, so a second **no-ivm Runner** ships from day one as a conformance
gate: every release runs the full scenario suite against both. If the
contract drifts between runners, the no-ivm runner catches it. Swapping to
a future isolate technology is a per-game flag, not a contract change.

## What would change our mind

1. **`isolated-vm` maintainer risk materializes** — abandonment, unfixed
   security issues, V8-version mismatches with current Node.
2. **A successor isolate library emerges** (Bun isolates, a better-
   maintained fork) with comparable or better isolation.
3. **Native escapes prove frequent enough** that `K > 1` blast radius is
   unacceptable for the main workload — drive `K` toward 1 for those
   presets first.

We are not litigating sandboxing depth further in v1; the goal is
validating the substrate **shape** end-to-end, with security depth a
tunable we revisit once the shape is exercised.

## See also

- [`subsystems/runner.md`](../subsystems/runner.md) — implementation details
- [`subsystems/broker.md`](../subsystems/broker.md) — the credential holder
- [`why-broker-runner.md`](why-broker-runner.md) — why a Broker + Runner pool
- [`vision/trust-model.md`](../vision/trust-model.md) — full trust positions
- [`vision/guarantees.md`](../vision/guarantees.md) #8 — crash blast radius
