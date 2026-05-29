# Scenario runner

> Layer: **Subsystem**

The scenario-runner is the substrate's testing surface. It is **dual-role**:

1. **Bundle authors** use it as their local iteration loop. Edit
   bundle → `pnpm scenario:run` → read `result.json` and `history.jsonl`
   → fix → repeat.
2. **Substrate CI** uses it as the production release gate. Every push
   runs the full scenario suite under each runtime (ivm + noivm) plus
   every nemesis profile, and a selected guarantee-oracle failure on any
   scenario blocks the release.

Same artifact, two consumers.

## Purpose

- Load a scenario manifest + workload + fixtures + oracles.
- Spin up a substrate runtime (live or in-memory).
- Drive the substrate through the workload phases.
- Optionally inject faults via a nemesis profile.
- Run the scenario manifest's selected substrate-side oracles plus any
  scenario-local bundle-correctness oracles. Full all-oracle replays are
  available for audits against histories that exercise every surface.
- Emit `result.json` with pass/fail per oracle, attribution sentences,
  and per-surface metric snapshots.
- Run a scenario catalog as a suite matrix, emitting one history/result pair
  per scenario × nemesis combination and a `suite.result.json` summary tagged
  with the Runner kind (`ivm` or `noivm`).

## Owns

- The scenario artifact schema (manifest, workload phases, fixtures,
  oracles).
- The workload phase executor (open WS sessions, send messages, sleep,
  expect, etc.).
- Nemesis fault injection (orthogonal profiles applied at runtime).
- The fixture-replay path into the gateway (`PAX_API_REPLAY_FIXTURES_PATH`).
- The 17-oracle library (`testing/oracles-lib/src/guarantees/`).
- The attribution-sentence ranker.
- `result.json` artifact emission.

## Doesn't own

- Bundle-correctness oracle implementations. Those live with each
  scenario at `examples/bundles/<bundle>/scenarios/<scenario>/oracles.mts`.
- URL service implementations under test. Either the substrate's
  reference URL services run live, or the scenario provides fixtures.

## Inputs

| Source | What |
|---|---|
| Scenario manifest | `manifest.mts`: scenario id, mode (load/property/fuzz/replay), bundle name, default nemesis, oracles to gate on |
| Scenario workload | `clients/workload.mts`: declarative phases (`seed-fixtures`, `open-sessions`, `expect-ws-refusals`, `send-json`, `expect-history-events`, etc.) |
| Scenario fixtures | `fixtures/initial-state.json`, `fixtures/initial-blob.json`, `fixtures/allowed-players.json`, `fixtures/api-responses/` (canned URL service responses keyed by fingerprint) |
| Nemesis profile | `fault-profile.mts`: timed actions like "kill shard every 5min" |
| Substrate history file | `var/history.jsonl` from a live or replay run |

## Outputs

| Destination | What |
|---|---|
| `result.json` | Pass/fail per oracle, attribution sentence, per-surface metrics, scenario metadata, history pointer |
| `suite.result.json` | Pass/fail summary for a scenario catalog under a runtime/nemesis matrix |
| `scale-ladder.result.json` / `rung.result.json` | Phase 5 scale-ladder summaries tying rung game count, shard-machine target, nemesis set, sampling profile, attribution, histories, and scenario results together |
| Tigris (if shipping) | History archive for replay |
| Self (Prometheus) | `pax_driver_*` metrics for the run |

## Scenario artifact shape

```
examples/bundles/<bundle>/scenarios/<scenario>/
  manifest.mts                # scenario metadata + oracle gate list
  clients/
    workload.mts              # the declarative phases
  fixtures/
    initial-state.json
    initial-blob.json
    allowed-players.json
    api-responses/
      <fingerprint>.json      # canned URL service responses
      ...
  oracles.mts                 # bundle-correctness oracles (scenario-local)
```

The substrate's own scenarios live at
`testing/scenarios/<scenario>/` and follow the same shape but target
the substrate's first-party example bundles under `examples/bundles/`.

## Run modes

| Mode | What happens |
|---|---|
| **load** | Steady-state workload at configurable concurrency; assert oracles continuously |
| **property** | Property-based test: workload is parameterized, runner explores the space |
| **fuzz** | Random workload generated within constraints; failures get shrunk |
| **replay** | Re-run against a saved history; URL service responses frozen via fixtures; oracles re-evaluate |

The same scenario manifest declares a `defaultMode`, and the CLI flag
`--mode` overrides.

## Workload phase executor

A workload is a declarative list of phases:

```ts
// clients/workload.mts
export const workload = [
  { type: 'seed-fixtures', fixtureKinds: ['allowed-players'] },
  { type: 'register-api-kinds', kinds: [{ kindName: 'mock-ai.v1', url: 'http://localhost:9081/_url-services/mock-ai-v1/invoke' }] },
  { type: 'open-sessions', playerSource: 'allowed-players', sessionsPerGame: 5, rampMs: 1000 },
  { type: 'expect-ws-refusals', attempts: [{ placementGameIndex: 1, connectGameIndex: 2, playerId: 'player-1', expectedCodes: [4403, 1011] }] },
  { type: 'send-json', channel: 'websocket', messagesPerSession: 1, intervalMs: 0, body: { type: 'chat', content: 'hi' } },
  { type: 'expect-history-events', events: ['session.opened', 'onPlayerMessage', 'ws.send'], minimumPerGame: 1 },
  { type: 'wait', durationMs: 1000 },
  { type: 'close-sessions', reason: 'scenarioComplete' },
  { type: 'expect-history-events', events: ['session.closed'], minimumPerGame: 1 },
];
```

The executor processes phases sequentially, talks to the substrate
over its public surfaces (admin REST, WS), and aborts on phase failure
(e.g. expected history event didn't arrive within timeout).

## Nemesis profiles

Orthogonal to the scenario. Three ship today:

| Nemesis | Behavior |
|---|---|
| `api-kind-partition-burst` | Temporarily rewire `mock-ai.v1` to an unroutable provider URL, then restore the prior registration |
| `no-faults` | Identity nemesis. Useful for steady-state validation |
| `shard-death-every-5m` | Kill a random shard machine every 5 minutes |

The nemesis runs as a separate process alongside the scenario; it talks
to the substrate's admin API to enact faults.

In the Phase 0 runner implementation, nemesis actions are scheduled inside
the driver process and still use admin REST. `kill-shard` selects an eligible
shard from `GET /admin/shards` and calls `POST /admin/shards/:id/drain`; the
Fly/orchestrator replacement hook is layered on top in later phases.

Adding a nemesis: drop a folder under `testing/nemeses/<name>/` with a
`fault-profile.mts`. The executor calls into it on a timer.

## Oracle library

`testing/oracles-lib/src/guarantees/` has 17 files, one per strong
platform guarantee:

| Guarantee # | File | Reads from history |
|---|---|---|
| 1 | `singleton-game.mts` | `game.created`, `isolate.created`, `isolate.disposed` |
| 2 | `allowed-only-connection.mts` | `session.opened`, `connection.refused`, allowed-players events |
| 3 | `unique-stable-sessionid.mts` | `session.opened`, `onPlayerMessage`, `session.closed`, every event with `sessionId` |
| 4 | `session-observability-accuracy.mts` | `session.opened`/`.closed`, `api.invoke.request` |
| 5 | `faithful-api-dispatch.mts` | `api.invoke.request`/`.response`/`.wire` |
| 6 | `idempotent-player-input.mts` | `onPlayerMessage` |
| 7 | `compute-plane-quotas.mts` | `compute.budget`, `compute.budget.rejected` |
| 8 | `crash-blast-radius.mts` | `isolate.disposed`, `isolate.restart`, `isolate.fatal`, `runner.crash` |
| 9 | `no-random-parent-crashes.mts` | `broker.crash` / `runner.crash` without `onSleep` (must never appear) |
| 10 | `eviction-minimum-budget.mts` | `onSleep.sent` + `lifecycle.sleepComplete` |
| 11 | `state-durability.mts` | `state.write`, `state.checkpoint`, `isolate.restart`, `onWake` |
| 12 | `blob-durability.mts` | `blob.put`, `blob.get`, `state.checkpoint`, `onWake` |
| 13 | `migration-rollback-safety.mts` | `bundle.flip.succeeded`, `onWake.failed`, `bundle.rollback.*` |
| 14 | `history-completeness.mts` | All events; checks `pax_seq` gap-freeness and required-fields |
| 15 | `bundle-compatibility-safety.mts` | `bundle.flip.refused`, `bundle.coldWake.rejected` |
| 16 | `placement-contract-safety.mts` | `placement.accepted`, `placement.refused` |
| 17 | `host-event-durability.mts` | `onHostEvent.received`, `onHostEvent.delivered` |

Each oracle is a pure function over history. They're side-effect-free,
unit-testable, and re-runnable on archived histories. Oracles are
named, not numbered — files use stable names, the
[`vision/guarantees.md`](../vision/guarantees.md) table maps numbers to
names.

Scenario-local bundle oracles live with each scenario and run after
the 17 substrate oracles. They have the same shape (history-reader
functions) but assert bundle-specific properties.

## Attribution sentence ranker

For load and stress modes, the runner emits an attribution sentence:

> "Previous rung's cliff was attributed to `broker.broadcast` (metric
> `pax_broker_broadcast_total_duration_seconds` p99 crossed 250 ms);
> this rung's change relaxes `broker.broadcast` by 40%."

The ranker is `setupBottleneckGuess`-style: compute (p99, max) per
(surface, metric) tuple, rank top 3, identify metrics crossing
attribution-playbook thresholds, identify metrics where the previous
hypothesis stayed flat (falsified). The output goes into
`result.json.attribution`.

A run with no attributable cliff still produces a sentence ("This
rung exhibited no cliff; all metrics within baseline").

## `result.json` shape

```jsonc
{
  "schemaVersion": 1,
  "scenarioId": "chat-steady-state",
  "runId": "run_2026-05-27T12:00:00Z",
  "mode": "load",
  "nemesis": "no-faults",
  "samplingProfile": "ramp",
  "startedAt": "...",
  "finishedAt": "...",
  "durationMs": 60000,
  "workerCount": 1,
  "oracles": {
    "singleton-game": { "ok": true, "observedEvents": 145 },
    "allowed-only-connection": { "ok": true, "observedEvents": 23 },
    "compute-plane-quotas": {
      "ok": false,
      "violations": [
        { "gameId": "game-1", "budget": "cpu-ms-per-tick", "usage": 1050, "limit": 1000 }
      ]
    },
    ...
  },
  "metrics": {
    "router": { "placement_ms": { "p50": 12, "p99": 87 } },
    "broker": { ... },
    "runner": { ... },
    "gateway": { ... }
  },
  "attribution": {
    "sentence": "...",
    "candidates": [...],
    "falsified": [...]
  },
  "historyUrl": "tigris://pax-backend-history/<shardId>/<runId>/...",
  "traceLinks": ["https://logs.betterstack.com/team/.../trace/<traceId>"]
}
```

## Sampling profiles

Three profiles control collector behavior:

| Profile | Metric scrape | Trace sampler | Metric families |
|---|---|---|---|
| `ramp` (default) | 30 s | 0.01 | all |
| `cliff_hold` | 1 s | 1.0 | `FAST_FAMILIES` allowlist only |
| `replay` | 0 (live-tail history) | 1.0 | n/a |

The runner auto-promotes the saturation rung ±1 to `cliff_hold`. The
allowlist exists to prevent the load-bot from OOMing on full
high-cardinality scrapes (e.g. per-isolate Runner metrics).

## Scale ladder mode

Phase 5 uses a declarative scale plan (`testing/scale-ladders/v1-scale.mts`)
with rungs from 100 games on one shard machine through the v1 soak target
of 1000 games on 10 shard machines. The scale runner executes a selected
rung by cloning the scenario workload with rung-specific `maxGames`,
`open-sessions` ramp/session count, per-case target duration, nemesis set, and
sampling profile. Rungs can also override the `send-json` interval and fanout
window so a concurrency soak can run at a bounded heartbeat while separate
throughput probes exercise higher message rates. During live runs it scrapes router, control-plane,
gateway, broker, and runner Prometheus endpoints, aggregates
samples online, applies the `cliff_hold` fast-family allowlist to
high-cardinality metrics, then ranks histogram/counter candidates for the
attribution sentence. Every rung writes a `rung.result.json`; the full
ladder writes `scale-ladder.result.json`.

## CI integration

```yaml
# .github/workflows/scenario-suite.yml
steps:
  - run: ./scripts/test/scenario-suite-local.sh
    env:
      PAX_SCENARIO_SUITE_RUNTIMES: ivm,noivm
      PAX_SCENARIO_SUITE_CATALOGS: testing/scenarios,examples/bundles/historia-default/scenarios
      PAX_SCENARIO_SUITE_NEMESES: all
      PAX_SCENARIO_SUITE_ORACLES: scenario
```

Any oracle failure exits non-zero. The smoke bot
(`testing/smoke-bot/`) is the M0 vertical smoke gate; the scenario suite
is the M1+ release gate. The configured catalogs are first-party proof
surfaces: the substrate catalog plus bundle proof catalogs such as
`historia-default`. Suite-mode workload game IDs include a per-suite nonce so
local release-gate reruns cannot observe stale Redis or Tigris-local state from
earlier invocations. The local suite wrapper also points each runtime at
output-scoped history, API-record, and local Tigris paths so proof artifacts are
self-contained.

## Trust position

**Platform-trusted** when running against a live substrate
(`pax-backend-driver`). Has admin token, can issue any admin call.

**Sandboxed** when used by bundle authors locally — runs against a
local-mac substrate that has no production secrets.

## End-state contract

- **Every scenario declares the guarantee oracles it exercises.** A
  failure in that selected set, or in any scenario-local oracle, is a
  release blocker. The all-oracles mode remains available for targeted
  audit runs against broad histories.
- **`replayCoverageGap` is a hard failure** (guarantee #5).
- **`result.json` is reproducible** under fixed `PAX_TEST_SEED` for
  property/fuzz modes.
- **Attribution sentence is always populated** (even if just "no cliff").

## Cross-references

- [`vision/guarantees.md`](../vision/guarantees.md) — the 17 guarantees
- [`contract/history-events.md`](../contract/history-events.md) — what
  oracles read
- [`api-gateway.md`](api-gateway.md) — replay mode wiring
- [`observability.md`](observability.md) — sampling profiles
- [`proofs/historia-default.md`](../proofs/historia-default.md) — the
  bundle-side use case
