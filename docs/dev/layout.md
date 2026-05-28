# Layout — where does it live?

Three sentences:

> **"Where does it run?"** answers the top-level folder.
> **"What kind of thing is it?"** answers the sub-folder; each zone has an
> opinionated index of kinds.
> **Multi-zone PRs are encouraged.** Helpers (`shared/`, `vendor/`,
> `docs/`, `scripts/`) live at the top because they're cross-zone by
> nature.

That's the whole convention. Everything else is derivable.

## The full mapping

| If your code runs on… | …it lives in… |
|---|---|
| a Rivet shard machine | `runtime/` |
| the control + gateway machine | `orchestration/` |
| the creator's machine (npm-installed by them) | `sdk/` |
| the scenario-runner driver machine | `testing/` |
| nowhere (a human reads it for context) | `examples/` |
| ≥2 of the above (wire-contract code) | `shared/` |
| our build / dev / CI infrastructure | `scripts/` |
| a third-party project we vendored | `vendor/` |

## Sub-layout: kind-folders

Each zone's `src/` is organized **by kind**, not by feature, not
alphabetically. One obvious folder per kind:

| Zone | Kind-folders (examples) |
|---|---|
| `runtime/parent-actor/src/` | `lifecycle/` (one file per hook), `ipc/` (one per channel), `budgets/` (one per compute budget), `sessions/` |
| `orchestration/placement-router/src/` | `gates/` (one per placement gate), `jwt.rs`, `directory.rs` |
| `orchestration/control-plane/src/` | `admin/<resource>/<action>.ts` (e.g. `admin/games/flip-bundle.ts`) |
| `orchestration/api-gateway/src/` | `registry.ts`, `envelope.ts`, `record-replay.ts`, `budgets.ts` |
| `orchestration/url-services/` | one folder per service: `echo/`, `delay/`, `http-fetch/`, `mock-ai.v1/` |
| `sdk/runtime-sdk/src/` | `c/<surface>.ts` (one per `c.*` surface), `manifest.ts`, `define-bundle.ts`, `types/` |
| `sdk/bundle-tools/src/` | `commands/<command>.ts` (one per CLI command) |
| `testing/oracles-lib/src/` | `guarantees/<name>.ts` (one per Strong Platform Guarantee, **named not numbered**) |
| `testing/scenarios/<scenario>/` | one folder per scenario |
| `testing/nemeses/<nemesis>/` | one folder per fault profile |
| `examples/bundles/<name>/` | one folder per demo bundle |

## Soft rules

- **One-file-per-kind is a target, not dogma.** Group small siblings
  (e.g., `state.read`/`state.write`/`state.flush` can share `state.ts`
  since they share buffer logic). The rule fires when a kind exceeds ~30
  lines of distinct logic.
- **Guarantee oracles use stable names, not numbers.**
  `singleton-game.ts`, `placement-contract-safety.ts`. The README's
  numbered §Strong Platform Guarantees becomes an index that maps
  "#15" → `bundle-compatibility-safety.ts`. Decouples filesystem identity
  from prose ordering.
- **`_internal/` is the standardized escape hatch** for zone-local shared
  code that doesn't belong under a kind-folder. Use sparingly. Documented
  in each per-zone README so readers don't get confused by non-conforming
  filenames.
- **No pre-created empty sub-folders.** Kind-folders (`lifecycle/`,
  `ipc/`, `budgets/`, `admin/`, etc.) get created when their first file
  lands. The convention is documented; the directory tree reflects what
  exists.

## What's deliberately NOT in this convention

- **No multi-zone PR ban.** Multi-zone PRs are encouraged for cross-cutting
  work. CI does not reject PRs that touch multiple zones; it only enforces
  things the layout can't (types compile, smoke is green, deploy tokens are
  scoped correctly).
- **No `shared/wire/spec/` + codegen on day one.** Defer until the Rust
  router (or any Rust consumer) actually needs to consume shared
  constants. Today's duplication (router's Redis row structs vs
  `@pax-backend/ipc-protocol`'s TypeScript interfaces) is a known debt
  with a known fix.
- **No substrate-purity grep, no bundle-manifest-valid CI, no
  teardown-allowlist CI, no workspace-discipline CI.** The layout
  obviates them or they're redundant with runtime checks
  (`defineBundle()` validates the manifest at every cold-start;
  `tear-down.sh`'s allowlist is reviewable in `git diff`; etc.).

## When the layout fails you

If you're writing a thing and none of the top-level folders feel right:

1. Check whether your thing actually belongs in two or more zones. If
   yes, put it in `shared/` and re-export.
2. Check whether your thing is actually multiple things. If yes, split.
3. If neither, the convention may need an honest extension. Open a PR
   that adds the new top-level folder AND updates this doc AND
   AGENTS.md's zone index. The folder doesn't exist until the convention
   does.
