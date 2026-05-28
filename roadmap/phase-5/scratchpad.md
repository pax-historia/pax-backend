# Phase 5 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-28 11:35 PDT

Started Phase 5. Re-read the roadmap directive and the relevant desired-state docs for scale: `docs-next/vision/substrate-overview.md`, `docs-next/subsystems/scenario-runner.md`, and `docs-next/subsystems/observability.md`. The target is explicit: 1000 concurrent games across 10 Rivet shard machines, with the runner narrating every cliff through per-surface metrics and attribution sentences.

Initial code audit shows the Phase 4 suite gate is in place, but Phase 5 still needs a real scale ladder path. The runner can emit `sampling_profile` and has a history-derived attribution helper, yet it does not currently scrape live `/metrics` endpoints during a rung or emit a rung-level artifact that ties game count, shard count, nemesis profile, sampling profile, and cost inputs together. First implementation work should close that artifact/measurement gap before attempting longer Fly soaks.

## 2026-05-28 11:49 PDT

Added the first Phase 5 scale-ladder implementation. The declarative plan lives at `testing/scale-ladders/v1-scale.mts` with rungs at 100/250/500/750/1000 games and 1/3/5/8/10 shard-machine targets. The runner has a new `--scale-plan` mode that can execute one or more selected rungs, emits `scale-ladder.result.json` plus one `rung.result.json` per rung, and stores the per-case scenario `result.json` and history paths under the rung output directory.

The scale runner reuses normal scenario execution rather than creating a separate driver path. It applies rung targets by overriding the loaded workload's `maxGames`, `durationMs`, `open-sessions` ramp/session count, and `send-json` message count derived from target duration. That keeps the scale path tied to the same manifest/oracle/runtime machinery as the Phase 4 release gate.

Verification so far: `pnpm --filter @pax-backend/scenario-runner check-types`, `git diff --check`, and a replay-mode scale smoke for `100g-1shard`. The replay smoke intentionally exited through the oracle-failure code on empty history, then verified the artifact shape: one ladder result, one rung result, two nemesis cases, `max_games: 100`, and `send-json.messagesPerSession: 1800`.

## 2026-05-28 12:00 PDT

Closed the first metrics-attribution gap. Non-replay scenario runs now start a Prometheus collector before workload execution and stop it after history archive collection. The collector scrapes router, control-plane, gateway, parent, and vendored-engine endpoints; summarizes scalars and histogram buckets into `result.json.metrics.per_surface`; records scrape endpoint/error metadata; and emits a ranked live attribution sentence. It uses online aggregation rather than retaining raw scrape lines so long soaks are bounded, and `cliff_hold` applies a small Rivet/engine fast-family allowlist.

Verification: package typecheck/build passed, `git diff --check` passed, a synthetic Prometheus collector smoke passed with parser coverage and engine-family dropping, and live local scenario invocations wrote scrape metadata plus live attribution into `result.json`. The live smoke scenarios were not used as correctness proofs because the current local stack produced scenario-oracle failures, but the metrics integration itself was present with nonzero samples and zero scrape errors.

## 2026-05-28 12:30 PDT

Completed the Fly shard scaling proof. `scripts/fly/scale-shards.sh 10` brought `pax-backend-shards` to ten started machines with one 20GB `pax_backend_rocks` volume per machine and stable shard slots:

- `2872d67f64e6e8` -> `shard-fly-iad-1`
- `85e297c4129998` -> `shard-fly-iad-2`
- `2862467b6693d8` -> `shard-fly-iad-3`
- `2860342b505d68` -> `shard-fly-iad-4`
- `d89590dc4e0568` -> `shard-fly-iad-5`
- `28624e2a959248` -> `shard-fly-iad-6`
- `78175d6ad56598` -> `shard-fly-iad-7`
- `d8927e5c706938` -> `shard-fly-iad-8`
- `48e64d3c0401d8` -> `shard-fly-iad-9`
- `e8204d2b7375e8` -> `shard-fly-iad-10`

The first driver smoke failed with `ECONNREFUSED` to the shard machine-specific `.vm.pax-backend-shards.internal:6420` URL. The recovery signal was clear in the shard log: the engine config had `guard.host = 0.0.0.0`, while Fly's private app/machine DNS resolves to IPv6 addresses. The fix was to set `RIVET_GUARD_HOST=::`, `RIVET_API_PEER_HOST=::`, and `RIVET_METRICS_HOST=::` in `fly.shards.toml` and the scale normalizer, then rerun the normalizer. Direct private curls from the driver to shard machine URLs then returned `{"runtime":"engine","status":"ok","version":"2.3.0-rc.5"}`.

Proof artifacts:

- `var/phase-5/fly-placement-proof-10.json` showed 10 registered, healthy, wake-accepting shard rows before the placement smoke.
- `var/phase-5/fly-placement-smoke/chat.history.jsonl` captured 256 `placement.accepted` events from the Fly driver smoke.
- `var/phase-5/fly-placement-proof-10-distribution.json` showed all 10 shards observed in placement distribution: 23, 28, 28, 32, 28, 27, 25, 24, 19, and 22 placements by shard.

The smoke was stopped after placement and message/close phases because the scenario's in-band `expect-history-events` phase waits on control-plane history before the runner's post-workload archive collection can append shard history. That is a scenario-runner ergonomics issue for future full soaks, not a placement-distribution blocker; the placement proof itself is complete.

## 2026-05-28 12:45 PDT

Added the first 10k-game cost projection at `roadmap/phase-5/cost-projection.md`. It uses current public Fly, Tigris, and Better Stack pricing checked today plus measured Task 4 topology: ten `performance-4x` 8GB shard machines in `iad`, ten attached 20GB shard volumes, two started control machines, and one active driver machine.

The projection keeps the proven density of 100 games per shard. At 10k games that means 100 shard machines and 2TB of provisioned Fly volume capacity. The working 10k monthly projection is $13,619.44: $12,802.24 for compute plus provisioned volume, $52 for a Tigris request/storage budget, $15.20 for low-change Fly volume snapshots, and a $750 Better Stack telemetry cap. This is infrastructure spend only; no substrate gameplay accounting primitive was added or implied.

## 2026-05-28 12:50 PDT

Prepared and launched the Phase 5 exit soak. Added `testing/scale-ladders/v1-soak.mts`, which keeps the v1 target at 1000 games / 10 shards but uses three 8-hour cases (`no-faults`, `shard-death-every-5m`, and `api-kind-partition-burst`) to make one 24-hour full-nemesis-suite window. The existing `v1-scale` plan remains the ladder; the new plan is only the exit-soak artifact.

Before launch, bumped `pax-backend-driver` to `shared-cpu-4x` / 2GB and redeployed the driver image so the soak plan exists inside `/app`. Also exposed parent metrics over private IPv6 by normalizing `PAX_PARENT_METRICS_BIND=:::7700`; driver curls now reach both `:7700/metrics` and `:6430/metrics` on shard 1.

Started detached `ivm` soak from driver machine `1854539b257768`:

```bash
PAX_SCENARIO_EXPECT_HISTORY_MODE=delay \
PAX_SCENARIO_EXPECT_HISTORY_DELAY_MS=30000 \
PAX_SCENARIO_ARCHIVE_FLUSH_WAIT_MS=30000 \
PAX_SCENARIO_ARCHIVE_WINDOW_PADDING_MS=120000 \
pnpm exec tsx testing/scenario-runner/src/cli.mts \
  --scale-plan testing/scale-ladders/v1-soak.mts \
  --scale-rung 1000g-10shards-24h-suite \
  --runtime ivm \
  --mode load \
  --backend live \
  --oracles scenario \
  --output-dir /data/phase-5/soak/ivm-20260528T193858Z \
  --output /data/phase-5/soak/ivm-20260528T193858Z/scale-ladder.result.json \
  --phase-timeout-ms 1200000 \
  --metrics-scrape-interval-ms 5000
```

The process PID is recorded at `/data/phase-5/soak/ivm-20260528T193858Z/run.pid`; stdout/stderr goes to `run.log`; final exit code goes to `exit.code`.

## 2026-05-28 13:02 PDT

Added `scripts/fly/summarize-soak.mts` for the eventual soak completion audit. It reads a pulled soak artifact directory, summarizes each `*.history.jsonl` and matching `*.result.json`, counts placements and shard distribution, lists completed workload phases, records failing oracles and attribution sentences, and can enforce expected case/game/shard gates. Verified it against the Task 4 placement-smoke artifacts: 256 placements across all 10 shards, no JSONL parse errors.

## 2026-05-28 13:06 PDT

The `ivm` soak reached the v1 target and entered hold. At `/data/phase-5/soak/ivm-20260528T193858Z`, the no-faults history had 1000 `placement.accepted` events and `open-sessions` completed at `2026-05-28T20:05:29.705Z` with `durationMs=1540879` (about 25m 41s). The run then started `send-json`, which is the 8-hour hold phase for the first nemesis case. The slower-than-configured 10-minute ramp is expected to be investigated in attribution after the run, but it is not a blocker while the hold remains alive.
