# Why: Rivet is vendored as an implementation detail

> Layer: **Why**

## Considered

Three relationships the substrate could have with Rivet:

1. **Rivet as an upstream dependency.** Track Rivet's main branch; consume
   it via Cargo/npm; substrate breaks when upstream breaks.
2. **Rivet as a load-bearing substrate component.** Rivet primitives
   (actors, tunnels, lanes, workflows) become part of the substrate's
   contract; operator overlays and SDK consumers know about them.
3. **Rivet as a vendored implementation detail.** Rivet source is
   committed into `vendor/rivet/` at a pinned commit. The substrate uses
   Rivet internally but never exposes Rivet vocabulary in any
   user-facing contract. Operator overlays know nothing about Rivet.

We chose option 3.

## Why we said no to options 1 and 2

### Why not option 1 (upstream dependency)

- **Rivet is pre-1.0 and in active refactor.** The sister-spike
  `pax-rivet-refactor` is actively fixing Rivet's UPS lanes, Tunnel v2,
  Executor lanes, and Routing Directory. Tracking that head from
  pax-backend would mean accepting churn we don't control.
- **The substrate needs reproducibility.** A specific Rivet commit is
  load-bearing for substrate guarantees; we need to be able to test
  against an exact version and have CI be deterministic.
- **Patch ledger.** If the substrate ever needs to add a patch (a bug
  fix, a config we can't pass in at runtime), an upstream-tracking
  dependency makes that brittle.

### Why not option 2 (Rivet as load-bearing component)

- **Rivet's API isn't a contract we want to commit to.** It's an
  implementation library; its surface area is large; the parts we use
  are a small slice; tying operator overlays to that slice would force
  the substrate to either reproduce Rivet's API in its own contract or
  expose Rivet directly to overlays.
- **The substrate's value proposition is the contract surface in
  [`contract/`](../contract/), not Rivet.** If a future replacement for
  Rivet emerges (Cloudflare Durable Objects v2, a different actor
  framework, a hand-rolled equivalent), the substrate should be able to
  swap implementations without rewriting overlays.

## Why Rivet vendored (option 3)

- **One pin, one source of truth.** `vendor/rivet/` is committed at a
  specific SHA; `vendor/rivet/UPSTREAM.md` records the pin and the
  re-pin procedure. CI builds against this pin every time.
- **Patch isolation.** If we need to add a substrate-specific patch, it
  lives in `vendor/rivet/` and is auditable in `git diff`. We do not
  push it upstream from this repo; bug fixes flow through
  `pax-rivet-refactor`.
- **Operator overlays are Rivet-blind.** The substrate's contract docs
  do not mention "actor", "tunnel", "lane", "workflow", "pegboard",
  "gasoline" except in `subsystems/` design docs where they're framed as
  internal implementation. Bundle authors and URL service authors
  consume only the substrate's contract surface.

## What we use Rivet for

- **Per-game actor lifecycle.** Each game is a Rivet actor; Rivet's
  workflow engine handles the actor's persistence, supervision, and
  cross-machine placement primitives.
- **Tunnels.** Rivet's tunnel system is the WS transport between the
  router-issued JWT handoff and the parent actor's WS-accept code.
- **Engine internals.** Pegboard (scheduling), UPS (work queues),
  guard (HTTP routing), workflow state.

What we use those for vs what we own ourselves:

| Concern | Rivet handles | Substrate owns |
|---|---|---|
| Actor placement on a shard | Yes | Plus the runtime-contract placement gate |
| WS handshake transport | Yes (via tunnel) | The JWT verification + session generation |
| Per-actor process supervision | Yes | The IPC envelope + lifecycle hooks |
| Compute-budget enforcement | No | All eight budgets |
| `c.api.invoke` dispatch | No | Gateway + record/replay |
| `c.state` / `c.blob` storage | No (uses RocksDB for *its own* state) | Tigris-canonical + flush window |
| History event emission | No | Parent actor writes structured JSONL |
| Bundle compatibility | No | Manifest validation + flip/wake gates |
| `sessionId` generation | No | Substrate primitive |

## What we capture from Rivet for observability

Vendored Rivet exports ~120 Prometheus metrics on `:6430/metrics`,
optional OTLP/gRPC traces via `RIVET_OTEL_ENABLED=1`, and
`tracing::instrument` coverage on ~50 hot paths. The substrate's
observability story pipes all of this through the same Vector + sink
chain as the rest of the substrate. See
[`subsystems/observability.md`](../subsystems/observability.md).

Rivet's metrics are namespaced `rivet_*`; the substrate's metrics are
namespaced `pax_*`. Both reach the same dashboards.

## The Rivet re-pin procedure

1. Confirm `pax-rivet-refactor`'s head is at a tested commit.
2. `rsync -a --delete pax-rivet-refactor/ vendor/rivet/`.
3. Edit `vendor/rivet/UPSTREAM.md` to record the new SHA and any notes.
4. Rebuild the engine binary via `scripts/build/build-engine.sh`.
5. Run `pnpm smoke` against the new engine.
6. Run the full scenario suite against the new engine.
7. Commit `vendor/rivet/` and `UPSTREAM.md` together.

We do not edit Rivet source inside `vendor/rivet/`. Upstream fixes go
through `pax-rivet-refactor`.

## What would change our mind

- **A successor to Rivet emerges** with comparable actor primitives and
  better engineering velocity. (We'd reconsider, but the substrate's
  contract is what we'd keep stable; the replacement would land as a
  new internal implementation.)
- **Rivet stabilizes to the point where the patch ledger goes empty and
  upstream tracking becomes safe.** (Possible long-term; for now, vendored.)

## See also

- [`vendor/rivet/UPSTREAM.md`](../../vendor/rivet/UPSTREAM.md) — the pin
- [`subsystems/parent-actor.md`](../subsystems/parent-actor.md) — how
  Rivet is used inside the parent actor
- [`subsystems/observability.md`](../subsystems/observability.md) — how
  Rivet's emitted signals fit the substrate's observability backbone
