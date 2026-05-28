# `testing/` — what runs on the driver machine

**Deploys to `pax-backend-driver`** (spun up on demand for load runs, torn
down after). The scenario-runner harness + scenarios + fault profiles +
oracle library + the smoke bot.

Renamed from `tooling/` because every package here exists to **exercise the
substrate** — not to help operators publish bundles (that's `sdk/`) and not
to demonstrate creator APIs (that's `examples/`).

## Contents

| Path | What it is |
|---|---|
| `scenario-runner/` | The scenario-bundle harness. Three run modes — load, property, fuzz — plus replay mode for cross-version oracle re-runs. Reads scenarios + nemeses + oracles, drives the substrate, writes artifacts. |
| `scenarios/` | First-party scenarios. One folder per scenario; each contains a `bundle/` (creator code or ref), a `clients/` script, fixtures, declarative oracles, PRNG seed, determinism-level claim. |
| `nemeses/` | Fault profiles (shard death every 5m, no faults, network blip every 30s, etc.). Orthogonal to scenarios — composed at run time. |
| `oracles-lib/` | Reusable oracle helpers. One file per Strong Platform Guarantee. **Guarantee oracle files use stable names, not numbers** (`singleton-game.ts`, `placement-contract-safety.ts`, ...). The README's numbered §Strong Platform Guarantees becomes an index that maps "#15" → `bundle-compatibility-safety.ts`. Decouples filesystem identity from prose ordering. |
| `smoke-bot/` | The vertical smoke driver. Seed Redis, GET placement, open WS, send/receive echo, assert history. End-to-end gate the substrate must pass before any release. |

## Sub-layout conventions

```
oracles-lib/src/guarantees/
  singleton-game.ts                  # README guarantee #1
  allowed-only-connection.ts         # #2
  unique-stable-sessionid.ts         # #3
  session-observability-accuracy.ts  # #4
  faithful-api-dispatch.ts           # #5
  idempotent-player-input.ts         # #6
  compute-plane-quotas.ts            # #7
  crash-blast-radius.ts              # #8
  no-random-parent-crashes.ts        # #9
  eviction-minimum-budget.ts         # #10
  state-durability.ts                # #11
  blob-durability.ts                 # #12
  migration-rollback-safety.ts       # #13
  history-completeness.ts            # #14
  bundle-compatibility-safety.ts     # #15
  placement-contract-safety.ts       # #16
  index.ts                           # the canonical #N → filename map

scenarios/<scenario>/
  bundle/                # creator code (or a ref to examples/bundles/)
  clients/               # client-side script
  fixtures/              # initial state, allowed-players, url-service responses
  oracles.ts             # which oracle-lib oracles fire
  manifest.ts            # PRNG seed, determinism level, etc.

nemeses/<nemesis>/
  fault-profile.ts       # what failures fire when
```

**Soft rules:** as in the zone READMEs — one-file-per-kind is a target,
`_internal/` is the escape hatch, kind-folders are created on first use.

Smoke today ships `smoke-bot/`, and `oracles-lib/` now has the first
source-only guarantee oracle package. The full scenario-runner + scenarios +
nemeses still land in a later pass.
