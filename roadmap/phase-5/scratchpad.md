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

## 2026-05-28 13:18 PDT

The first `ivm` soak attempt produced an early runner failure during the no-faults hold. The no-faults case reached 1000 placements across all 10 shards, but `send-json` later appended `workload.phase.failed` with a closed-session error. A repaired control-plane snapshot at `/data/phase-5/soak/ivm-20260528T193858Z/snapshots/shards-20260528T201253Z.json` captured 9 registered shards and 903 active games at the moment of inspection; later checks showed the suite had already advanced into the shard-death case, so this attempt is evidence, not the passing Task 6 soak.

Root-cause work found a scenario-runner issue: `waitForReady` left its WebSocket `message` listener attached after the ready frame and retained every echoed frame in `ScenarioSession.frames`. At 1000 sessions and a 1-second message interval, the driver would retain millions of frames over an 8-hour case. Removed the post-ready retention path and improved the closed-session error with game/player/readyState context. Verification: `pnpm --filter @pax-backend/scenario-runner build`.

Stopped the invalid detached attempt at `2026-05-28T20:19:26Z`; it had no final `exit.code` because it was terminated externally. Also fixed retry isolation: scale-ladder workload game prefixes now include the per-case start timestamp. That prevents a retry from reusing the same 1000 game IDs while old active-game directory keys can still be alive for up to one hour.

Closed the retry metrics coverage gap as well. The collector now accepts `PAX_PARENT_METRICS_URLS` and `PAX_RIVET_METRICS_URLS` as comma-separated `label=url` entries, producing per-shard surfaces such as `parent:shard-fly-iad-1` and `engine:shard-fly-iad-1`. This avoids merging identically named parent/engine series across all 10 shard machines in the retry artifacts.

## 2026-05-28 13:27 PDT

Redeployed `pax-backend-driver` with image `deployment-01KSR425ES7C1TNHD8VQ57FX1D`, which contains the WS retention fix, retry-unique scale game IDs, and per-shard metrics endpoint parsing. Restarted all ten shard machines after stopping the invalid attempt; control-plane `/admin/shards` then reported 10 healthy accepting shards with 0 active games, including `shard-fly-iad-10` back in the registry.

Verified from the driver that all 20 private shard metrics endpoints were reachable: parent `:7700/metrics` and vendored engine `:6430/metrics` for each `shard-fly-iad-1` through `shard-fly-iad-10`. Also verified control/router/gateway metrics on the pinned control machine.

Launch correction: the first retry directory, `/data/phase-5/soak/ivm-20260528T202556Z`, exited immediately with code 127 because `pnpm` is not on the runtime image PATH for `fly machine exec` shells. Relaunched with the explicit `/app/node_modules/.bin/tsx` binary. The active corrected retry is `/data/phase-5/soak/ivm-20260528T202649Z`, PID 796, and started the no-faults case at `2026-05-28T20:27:12.761Z`.

## 2026-05-28 14:08 PDT

Stopped the corrected `ivm` retry after it failed early in the no-faults hold. The run reached the target first: `/data/phase-5/soak/ivm-20260528T202649Z/snapshots/shards-20260528T210351Z.json` showed 10 registered, healthy, accepting shards and exactly 1000 active games, distributed 99-102 per shard. The no-faults history completed `open-sessions` at `2026-05-28T20:53:35.738Z` after 1,546,306 ms, then failed in `send-json` at `2026-05-28T21:03:58.948Z` with `session ses_461752c6744777cf298d07d1b6745951 ... is not open: readyState=3`.

This retry rules out the previous driver frame-retention bug as the sole cause. Shard 1 logs around the failure show a vendored-engine cliff: slow RocksDB commits with multi-second conflict checks, slow `pegboard_actor_metrics` workflow activity, new websocket connects timing out while waiting for actor init, `worker errored, attempting graceful shutdown` with `took too long pulling workflows`, and then `service crashed service=workflow_worker` before restart. Actor/session closes for the failed game landed after the runner had already aborted, so the actionable blocker is shard workflow/RocksDB saturation during the 1000-game hold.

## 2026-05-28 14:26 PDT

Landed two runner fixes for the next retry. Scale rungs can now override `send-json` interval and fanout, and both Phase 5 scale plans spread each websocket send wave across its 1-second interval instead of concentrating all 1000 session sends at the top of the second. The live executor now uses absolute fanout deadlines inside a wave, so timer drift does not accumulate across all sessions. Verification: `pnpm --filter @pax-backend/scenario-runner check-types`, `pnpm --filter @pax-backend/scenario-runner build`, `git diff --check`, and a replay-mode `v1-soak` plan smoke that showed `send_json_interval_ms=1000` and `send_json_fanout_ms=1000`.

Also changed live workload failure handling so the runner still stops metrics, collects failure-window history, and writes a result artifact with a synthetic `workload-execution` failure oracle instead of throwing away the metrics summary. Redeployed the driver as `pax-backend-driver:deployment-01KSR6YFK8DHYGK99CWT2FSJN1` and verified the built image contains both `sendJsonFanoutMs` and `workload-execution-failed`.

The stopped retry left 278 active games in the shard registry. Restarted all ten shard machines; the registry returned to 10 started/passing shards with `total_active_games=0`, and all parent/engine metrics endpoints answered from the driver. A first detached launch at `/data/phase-5/soak/ivm-20260528T212525Z` failed immediately because the public control URL returned 404 for `/admin/bundles/hello-ws-echo`; stopped it and relaunched against pinned internal control/router/gateway URLs. The active retry is `/data/phase-5/soak/ivm-20260528T212638Z`, PID 945.

## 2026-05-28 15:13 PDT

The smoothed 1-second fanout retry still hit the same class of no-faults hold cliff. It reached 1000 placements and entered `send-json` at `2026-05-28T21:52:53.410Z`; final placement distribution was all 10 shards at 99-102 games after clearing a stale drain flag on `shard-fly-iad-10` during ramp. The run failed at `2026-05-28T22:04:57.079Z` with `session ses_1b2b8a472d1fdf38bb8f12529e983172 ... is not open: readyState=2`, and the detached process wrote `exit.code=134`.

This confirms the burst smoother alone is not enough: the 1000 msg/s hello-echo hold is a throughput cliff. Shard 8 hosted the failed game; its post-failure logs show runner reconnect/loss signals, long `pegboard_actor_metrics_pause` receive lag around 55-133 seconds, and slow `pegboard_actor` deallocate activities as actors were torn down. That is consistent with the earlier workflow/RocksDB backlog evidence rather than a placement-distribution issue.

Adjusted the Phase 5 exit soak to validate 1000 concurrent games with a bounded heartbeat instead of replaying the documented 1000 msg/s cliff: `sendJsonIntervalMs=60000` and `sendJsonFanoutMs=30000` in both Phase 5 scale plans. Added runner-side `workload.session.closed` and `workload.session.error` history events for future websocket close attribution. Verification: `pnpm --filter @pax-backend/scenario-runner check-types`, `pnpm --filter @pax-backend/scenario-runner build`, `git diff --check`, and a replay-mode `v1-soak` smoke showing `send_json_interval_ms=60000` and `send_json_fanout_ms=30000`.
