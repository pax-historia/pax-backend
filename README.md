# pax-backend

The substrate: a general-purpose-shaped backend that runs untrusted creator JavaScript inside per-game sandboxes, brokers WebSocket sessions between browsers and that JavaScript, dispatches outbound calls through a typed `c.api.invoke` channel to operator-defined URL services, records every channel call and session transition into a single observable history, and enforces per-game compute-plane budgets. It stays deliberately ignorant of everything business-shaped — billing, identity, roles, metadata, moderation policy — exposing a small typed surface to bundle authors and a small admin REST surface to the vercel backend that drives it.

Production deploys exactly one tenant (Pax-historia), but the substrate is designed as if multi-tenant. That discipline produced better contracts.

## Where to look

- **[`docs-next/`](docs-next/)** is the canonical description of what the substrate looks like once shipped. Vision, contract surface, subsystems, reference catalogs, and a `why/` page for every load-bearing design decision. Read this first; if anything else in the repo disagrees with it, `docs-next/` wins.
- **[`roadmap/README.md`](roadmap/README.md)** is the current execution status. Six phases, three states each (`complete`, `in_progress`, `to_do`), one directive and one exit signal per phase. Per-phase task trackers and scratchpads live in `roadmap/phase-N/`.
- **[`AGENTS.md`](AGENTS.md)** is the short-form pointers and the standing constraints for autonomous work in this repo.

## Repo zones

The repo is divided into seven zones; each answers "where does this code run?" mechanically.

| Zone | What lives there | Deploys to |
|---|---|---|
| [`runtime/`](runtime/) | Rivet engine, parent actor, child runners, shard image | `pax-backend-shards` |
| [`orchestration/`](orchestration/) | Placement router, control plane, API gateway, reference URL services | `pax-backend-control` |
| [`sdk/`](sdk/) | Typed creator surface, harness, bundle CLI | npm |
| [`testing/`](testing/) | Scenario-runner, scenarios, nemeses, oracle library, smoke bot | `pax-backend-driver` (on demand) |
| [`examples/`](examples/) | Reference creator bundles and URL service implementations | never deployed |
| [`shared/`](shared/) | Cross-zone wire-contract code (e.g. `@pax-backend/ipc-protocol`) | imported by ≥2 zones |
| [`vendor/`](vendor/) | Vendored Rivet (read-only) | rebuilt into the shard image |

Top-level helpers — [`docs-next/`](docs-next/), [`scripts/`](scripts/), [`roadmap/`](roadmap/) — are cross-zone.

## Scale target

One thousand concurrent games across ten Rivet shard machines. The interesting properties — router throughput, per-shard hibernation, cross-shard migration, redeploy safety, history completeness under load — are all measurable at this size. Initial Fly footprint and reasoning in [`docs-next/vision/substrate-overview.md`](docs-next/vision/substrate-overview.md).
