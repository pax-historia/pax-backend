# `shared/` — cross-zone contract code

Code that crosses zone boundaries by being imported from multiple zones.
The substrate's wire-shape definitions live here so the parent (in
`runtime/`), the child (in `runtime/`), the SDK (in `sdk/`), the smoke
bot (in `testing/`), and the router (in `orchestration/`) all agree on
exactly the same envelopes, key prefixes, and TTLs.

The package(s) in here are intentionally **logic-light** — pure types,
constants, and tiny helpers. Anything with substantive behavior belongs
in the zone that owns the behavior. If a shared package starts growing
runtime logic, that's a signal we need to move it back into its proper
home zone and re-export only the types.

## Contents

| Path | What it is |
|---|---|
| `ipc-protocol/` | `@pax-backend/ipc-protocol`. The versioned IPC envelope types (parent ↔ child + parent ↔ child internals), discriminated unions tagged on `.type`, Redis key prefixes + TTLs, ID generators (`generateSessionId`, `generateRunId`), and the Redis row schemas (`ShardRegistration`, `ActiveGamePlacement`, `BundleRecord`, `GameRecord`). |

## Why it's at the top level, not under `runtime/`

The IPC protocol could plausibly live under `runtime/ipc-protocol/` since
the parent and child are the only IN-PROCESS consumers. But:

- The placement router (`orchestration/placement-router/`, Rust) needs the
  same Redis schemas to read `shards:*` and `games:*` rows.
- The smoke bot (`testing/smoke-bot/`) needs the same `BundleRecord` /
  `GameRecord` types to seed Redis correctly.
- The SDK (`sdk/runtime-sdk/`) re-exports manifest types from here so
  bundle authors don't import directly from a `runtime/` package.

When more than one zone imports a package, that package lives in
`shared/`. The router's Rust side currently duplicates the JSON shapes
manually (see `orchestration/placement-router/src/main.rs` Redis row
structs); when a second-language consumer materializes, we'll generate
both sides from a single source — but per the plan's softening
adjustments, **no `shared/wire/spec/` + codegen on day one.** Today's
duplication is a known debt with a known fix.

## Adding to `shared/`

Don't, unless a package is provably consumed across ≥2 zones. Drift
between zone copies is easier to detect and fix than convergence on a
shared abstraction that turns out to be wrong.
