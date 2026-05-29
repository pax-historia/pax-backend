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

## 2026-05-28 15:21 PDT

Redeployed `pax-backend-driver` with image `deployment-01KSRAD616BRYR52NPJ8YQ1WGY`, then verified the runtime image contains the one-minute heartbeat settings and `workload.session.closed` history instrumentation. A post-deploy registry check showed `shard-fly-iad-3` missing from the control-plane registry even though its Fly machine was still started, so restarted shard machine `2862467b6693d8`; `/admin/shards` then returned 10 healthy accepting shards with `total_active_games=0`.

Preflight from the driver verified all 20 per-shard metrics endpoints, parent `:7700/metrics` and vendored engine `:6430/metrics`, plus control/router/gateway metrics on the pinned control machine. Started the heartbeat `ivm` retry detached at `/data/phase-5/soak/ivm-20260528T222045Z`, PID 798, using pinned internal control/router/gateway URLs and per-shard metrics labels. The launch check found the process alive and the no-faults history file created.

## 2026-05-28 15:48 PDT

The heartbeat `ivm` retry reached the full v1 target and entered hold. The no-faults case completed `open-sessions` at `2026-05-28T22:47:07.373Z` after 1,545,296 ms, then started `send-json`. The history file showed 1000 `placement.accepted` events across all 10 shards with distribution: shard-fly-iad-1=100, shard-fly-iad-2=101, shard-fly-iad-3=100, shard-fly-iad-4=99, shard-fly-iad-5=99, shard-fly-iad-6=100, shard-fly-iad-7=100, shard-fly-iad-8=101, shard-fly-iad-9=98, shard-fly-iad-10=102.

The simultaneous control-plane `/admin/shards` snapshot matched: 10 healthy accepting shards and `total_active_games=1000` with the same 98-102 per-shard distribution. Runner-side history still had zero `workload.phase.failed`, zero `workload.session.closed`, and zero `workload.session.error` events at hold entry.

## 2026-05-28 16:01 PDT

The heartbeat retry cleared the earlier no-faults hold failure window. At about 14.5 minutes after `send-json` started, the detached driver process was still alive, no `exit.code` existed, and the no-faults history still had zero `workload.phase.failed`, zero `workload.session.closed`, and zero `workload.session.error` events. This is the first retry to stay healthy past the prior 1000 msg/s cliff timing; leave the run detached and continue periodic hold checks.

## 2026-05-28 16:07 PDT

Preserved a remote hold snapshot under `/data/phase-5/soak/ivm-20260528T222045Z/snapshots/`: `shards-20260528T230507Z.json` plus a corrected exact history summary at `no-faults-hold-20260528T230507Z.summary.json`. The summary records 1000 placements, 98-102 per shard, zero workload failures, zero runner-side session closes/errors, and the no-faults `send-json` phase still active.

Started a detached driver-side monitor for the rest of the run: `/data/phase-5/soak/ivm-20260528T222045Z/monitor/monitor.js`, PID 2039, appending five-minute JSON status snapshots to `/data/phase-5/soak/ivm-20260528T222045Z/monitor/status.jsonl`. The first monitor line matched the live check: process alive, no exit code, 10 healthy accepting shards, `total_active_games=1000`, and no history failures.

## 2026-05-28 16:13 PDT

Confirmed the detached monitor cadence. The second monitor line landed at `2026-05-28T23:12:23.154Z`; the heartbeat `ivm` retry was still alive with no `exit.code`, the no-faults history still had 1000 placements and zero workload failures/session close/session error events, and `/admin/shards` still showed 10 healthy accepting shards with `total_active_games=1000`. This puts the no-faults hold about 25 minutes past `send-json` start and still green.

## 2026-05-28 16:15 PDT

Added `scripts/fly/pull-soak-artifacts.sh` so partial `fly machine exec` streams do not corrupt local evidence pulls. The helper base64-encodes a remote tar stream before decoding and merging into ignored `var/` locally; raw binary stdout through `fly machine exec` was not safe because it text-normalized gzip bytes. Verified it against `/data/phase-5/soak/ivm-20260528T222045Z`, then ran `scripts/fly/summarize-soak.mts` over the pulled copy; the in-progress summary saw one no-faults case, 1000 placements across all 10 shards, zero parse errors, and no failing/error cases yet.

## 2026-05-28 16:18 PDT

Extended `scripts/fly/summarize-soak.mts` to include `monitor/status.jsonl` when present, summarizing snapshot count, first/last monitor timestamp, last process/exit status, last shard count, active games, and aggregate workload failure/session close/session error counts. Verified it against the pulled active soak after the third monitor line at `2026-05-28T23:17:23.279Z`; the monitor summary showed three clean snapshots, last process alive, no exit code, 10 shards, 1000 active games, and zero failures/closes/errors.

## 2026-05-28 16:21 PDT

Preliminary Phase 5 verification audit caught cost-projection drift from the soak driver resize. `fly machines list` now shows the active and standby driver machines on `shared-cpu-4x` / 2GB, while the projection still used the earlier `shared-cpu-1x` / 1GB row. Updated `roadmap/phase-5/cost-projection.md`: the 1k-game v1 footprint is now $1,294.18/month for compute plus provisioned volume and the working 1k monthly projection is $1,541.38.

## 2026-05-28 16:22 PDT

Fourth detached monitor snapshot landed at `2026-05-28T23:22:23.363Z`. The heartbeat `ivm` no-faults case remained in `send-json`, process alive with no `exit.code`, 1000 active games across 10 healthy accepting shards, and zero workload failures/session closes/session errors. This puts the no-faults hold about 35 minutes past start and still stable.

## 2026-05-28 16:26 PDT

The verification audit found one scale-plan wording/semantics drift: `targetDurationMs` is applied per nemesis case, but the older `v1-scale` 1000-game rung still carried the full 24-hour exit-soak duration and note. Kept the actual 24-hour full-suite exit proof in `testing/scale-ladders/v1-soak.mts` and made the `v1-scale` 1000-game rung a one-hour target-concurrency rung. Also clarified the per-case duration wording in the scenario-runner docs so future runs do not accidentally turn a three-nemesis rung into a 72-hour job. Verification: `pnpm --filter @pax-backend/scenario-runner check-types`, `git diff --check`, and a replay-mode `v1-scale` 1000-game rung smoke confirmed `target_duration_ms=3600000` with the three expected nemesis cases; the replay smoke exited through expected oracle failures on empty history.

## 2026-05-28 16:28 PDT

Fifth detached monitor snapshot landed at `2026-05-28T23:27:23.444Z`. The active heartbeat `ivm` no-faults case was still alive in `send-json` with no `exit.code`, 1000 active games across 10 healthy accepting shards, zero workload failures/session closes/session errors, and no monitor parse errors. Pulled the remote soak directory with `scripts/fly/pull-soak-artifacts.sh` and summarized it locally; the summary had one in-progress case, 1000 placements across all 10 shards, `gates_ok=true`, and five clean monitor snapshots.

## 2026-05-28 16:33 PDT

Sixth detached monitor snapshot landed at `2026-05-28T23:32:23.565Z`, about 45 minutes into the no-faults hold. The runner wrapper, tsx process, and monitor process were alive; sampled metrics endpoints for control/router/gateway plus parent and engine on shards 1, 5, and 10 answered from the driver. The pulled local summary still showed one in-progress no-faults case, 1000 placements across all 10 shards, `gates_ok=true`, six clean monitor snapshots, no `exit.code`, and zero failures/session closes/session errors.

## 2026-05-28 16:36 PDT

Tightened the final soak audit gates in `scripts/fly/summarize-soak.mts`. It can now require exact case IDs, completed workload phases, and an expected runner `exit.code` in addition to result files, placement counts, shard coverage, and monitor parse health. Verified the default in-progress summary still passes for the active pulled soak, while the intended final gate command correctly fails today because only the no-faults case exists, result files are not written yet, `exit.code` is still absent, and `send-json`/`close-sessions`/`expect-history-events` are not complete.

## 2026-05-28 16:38 PDT

Seventh detached monitor snapshot landed at `2026-05-28T23:37:23.663Z`. The heartbeat `ivm` no-faults case remained alive in `send-json` with no `exit.code`, 1000 active games across 10 healthy accepting shards, zero workload failures/session closes/session errors, and no monitor parse errors. Pulled the remote soak directory and summarized it locally; the in-progress summary now has seven clean monitor snapshots and still reports `gates_ok=true` for the non-final default gates.

## 2026-05-28 16:40 PDT

Added `scripts/fly/verify-v1-soak.sh`, a small wrapper around `scripts/fly/summarize-soak.mts` with the Phase 5 exit-soak gates wired in: all three expected nemesis case IDs, 1000 placements per case, 10 placement shards, completed workload phases, `exit.code=0`, and required result files. Verification: `bash -n scripts/fly/verify-v1-soak.sh`, then ran it against the current pulled active soak and confirmed it fails for the right in-progress reasons: only no-faults exists, result files are not written yet, `exit.code` is absent, and the no-faults hold phases are still incomplete.

## 2026-05-28 16:43 PDT

Eighth detached monitor snapshot landed at `2026-05-28T23:42:23.715Z`. The heartbeat `ivm` no-faults case remained alive in `send-json` with no `exit.code`, 1000 active games across 10 healthy accepting shards, zero workload failures/session closes/session errors, and no monitor parse errors. The pulled local summary now has eight clean monitor snapshots and still reports `gates_ok=true` for the in-progress default gates.

## 2026-05-28 16:48 PDT

Closed a final verifier gap before the run gets much farther: `scripts/fly/summarize-soak.mts` now records per-case `duration_ms` from the first and last history timestamps, and `scripts/fly/verify-v1-soak.sh` requires each expected v1 soak case to span at least 28,800,000 ms. Verification: `git diff --check`, `bash -n scripts/fly/verify-v1-soak.sh`, the default in-progress summary still passed, the final verifier still failed for the right in-progress reasons plus the new under-duration gate, and `pnpm typecheck` passed.

Ninth detached monitor snapshot landed at `2026-05-28T23:47:23.838Z`. The heartbeat `ivm` no-faults case remained alive in `send-json` with no `exit.code`, 1000 active games across 10 healthy accepting shards, zero workload failures/session closes/session errors, and no monitor parse errors. Pulled the remote soak directory locally again; the summary now has nine clean monitor snapshots, 1000 placements across all 10 shards, and `gates_ok=true` for the non-final default gates.

## 2026-05-28 16:51 PDT

Tightened the same final verifier surface so `--expect-cases 3` now means exactly three cases rather than at least three. This prevents a polluted artifact directory with extra successful histories from satisfying the release gate. Verification: `git diff --check`, the default in-progress summary still passed, and `scripts/fly/verify-v1-soak.sh` still failed the active partial soak for the expected in-progress reasons with the exact-count message.

## 2026-05-28 16:52 PDT

Tenth detached monitor snapshot landed at `2026-05-28T23:52:23.961Z`. The heartbeat `ivm` no-faults case remained alive in `send-json` with no `exit.code`, 1000 active games across 10 healthy accepting shards, zero workload failures/session closes/session errors, and no monitor parse errors. Pulled the remote soak directory locally again; the summary now has ten clean monitor snapshots, 1000 placements across all 10 shards, and `gates_ok=true` for the non-final default gates.

The run and monitor logs stayed quiet. A `/proc` child walk from the driver showed the run wrapper PID 798 still supervising the `tsx`/Node scenario-runner process, and monitor PID 2039 still running. A full metrics liveness sweep from the driver passed for control, router, gateway, and both parent `:7700/metrics` plus vendored engine `:6430/metrics` on all ten shard machines.

## 2026-05-28 16:54 PDT

Tightened the placement-shard final gate to apply per case instead of across the union of all case histories. That ensures each nemesis case must independently show placements across all 10 shard machines. Verification: `git diff --check`, the default in-progress summary still passed with the no-faults case observing 10 shards, `scripts/fly/verify-v1-soak.sh` still failed the active partial soak for the expected in-progress reasons, and `pnpm typecheck` passed.

## 2026-05-28 16:56 PDT

Added one more final-gate guard: if a case has a `.result.json` file but it is not a recognized `scenario-result` artifact, `scripts/fly/summarize-soak.mts` now reports that explicitly. Verification: `git diff --check`, the default in-progress summary still passed, `scripts/fly/verify-v1-soak.sh` still failed the active partial soak for the expected in-progress reasons, and `pnpm typecheck` passed.

## 2026-05-28 16:58 PDT

Eleventh detached monitor snapshot landed at `2026-05-28T23:57:24.049Z`. The heartbeat `ivm` no-faults case remained alive in `send-json` with no `exit.code`, 1000 active games across 10 healthy accepting shards, zero workload failures/session closes/session errors, and no monitor parse errors. Pulled the remote soak directory locally again; the summary now has eleven clean monitor snapshots, 1000 placements across all 10 shards, and `gates_ok=true` for the non-final default gates.

## 2026-05-28 16:59 PDT

Tightened the duration proof to check completed phase durations, not only whole-case span. `scripts/fly/summarize-soak.mts` now records `completed_phase_durations_ms`, and `scripts/fly/verify-v1-soak.sh` requires a completed `send-json` duration of at least 28,700,000 ms per case. Verification: `git diff --check`, the default in-progress summary still passed and now shows the completed `seed-fixtures`/`open-sessions` durations, `scripts/fly/verify-v1-soak.sh` still failed the active partial soak with the new missing `send-json` duration gate, and `pnpm typecheck` passed.

## 2026-05-28 17:04 PDT

Twelfth detached monitor snapshot landed at `2026-05-29T00:02:24.174Z`. The heartbeat `ivm` no-faults case remained alive in `send-json` with no `exit.code`, 1000 active games across 10 healthy accepting shards, zero workload failures/session closes/session errors, and no monitor parse errors. The first artifact pull hit a transient Fly API connection reset; the retry succeeded, and the local summary now has twelve clean monitor snapshots, 1000 placements across all 10 shards, and `gates_ok=true` for the non-final default gates.

## 2026-05-28 17:11 PDT

The heartbeat `ivm` retry failed after the twelfth clean monitor snapshot. A later pull captured `exit.code=134`, 2007 no-faults history events, one `workload.phase.failed`, and 1000 `workload.session.closed` records. The phase failure landed at `2026-05-29T00:04:08.999Z`: `session ... is not open: readyState=3`. The local final verifier failed as expected: only the no-faults case exists, result files are missing, `exit.code` is 134, error events are present, the case duration was only 6,201,463 ms, `send-json` never completed, and the monitor observed one workload failure.

Failure attribution is localized to shard-fly-iad-1. Before scenario-runner abort cleanup, there were 100 non-abort closes and every one mapped to shard-fly-iad-1 placements: 18 `1011/core.internal_error`, 16 `1011/guard.websocket_service_timeout`, and 66 code `1006` closes. The remaining 900 closes were normal `scenarioRunnerAbort` cleanup after the failure. Fly machine status for shard machine `2872d67f64e6e8` showed two automatic restarts around `2026-05-29T00:06:42Z` and `2026-05-29T00:07:56Z`; the second recorded `exit_code=1`, `oom_killed=false`, `requested_stop=false`. Shard logs after restart showed `workflow pull backlog`, span dropping, slow `pegboard_actor` `deallocate` activity, and Vector history sink corrupted-event drops while parent/engine came back up. This is the same failure family as the earlier shard workflow/RocksDB saturation, now reproduced under the one-minute heartbeat profile on shard 1.

Tightened `scripts/fly/summarize-soak.mts` default gates so a failed in-progress summary no longer reports green: non-zero `exit.code`, case error events, and monitor-observed workload failures now make `gates_ok=false` even without final-gate options. Verification: `git diff --check`, default summary over the failed artifacts exits 2 with those three failures, `scripts/fly/verify-v1-soak.sh` exits 2 with the full final-gate failure list, and `pnpm typecheck` passed.

After failure cleanup, `/admin/shards` returned 10 healthy accepting shards with `total_active_games=0`. The failed run wrapper PID 798 and monitor PID 2039 were both dead, and the remote failed-run directory retained `exit.code=134`.

## 2026-05-28 17:19 PDT

Restarted all ten shard machines before retrying, then verified `/admin/shards` returned 10 healthy accepting shards with `total_active_games=0`. A full driver-side metrics preflight passed for control, router, gateway, and parent `:7700/metrics` plus vendored engine `:6430/metrics` on every shard machine.

Launched the next heartbeat `ivm` retry at `/data/phase-5/soak/ivm-20260529T001941Z`, reusing the pinned internal control/router/gateway URLs and per-shard metrics labels from the failed run. The run wrapper is PID 3282 and the detached monitor is PID 3313. The first monitor snapshot landed at `2026-05-29T00:19:43.705Z` with process alive, no `exit.code`, one in-progress no-faults history, and 10 healthy empty shards while `seed-fixtures` had just started.

## 2026-05-28 17:21 PDT

Added session-close distributions to `scripts/fly/summarize-soak.mts` so failure summaries include close counts by WebSocket code and reason prefix instead of requiring ad hoc parsing. Verification against the failed `ivm-20260528T222045Z` artifacts now reports 1000 closes split as code 1000=900, 1006=66, 1011=34, with reason prefixes `scenarioRunnerAbort`=900, `core.internal_error`=18, `guard.websocket_service_timeout`=16, and `<empty>`=66. `git diff --check` and `pnpm typecheck` passed.

## 2026-05-28 17:26 PDT

Second monitor snapshot for the fresh retry landed at `2026-05-29T00:24:43.871Z`. The run remained alive with no `exit.code`, zero workload failures/session closes/session errors, and 10 healthy accepting shards. The monitor saw 172 placements and 170 active games during `open-sessions`; the subsequent local pull caught the ramp at 217 placements across all 10 shards, still with no session closes and `gates_ok=true` for the non-final default gates.

## 2026-05-28 17:31 PDT

Third monitor snapshot for the fresh retry landed at `2026-05-29T00:29:43.992Z`. The run remained alive with no `exit.code`, zero workload failures/session closes/session errors, and 10 healthy accepting shards. The monitor saw 360 placements and 358 active games during `open-sessions`; the subsequent local pull caught the ramp at 407 placements across all 10 shards, still with no session closes and `gates_ok=true` for the non-final default gates.

## 2026-05-28 17:38 PDT

The fresh heartbeat retry failed during no-faults `open-sessions`, before it reached the hold. The fourth monitor snapshot at `2026-05-29T00:34:44.078Z` showed one workload failure and only 9 healthy shards; pulling the stopped artifacts produced `gates_ok=false` with 440 no-faults placements, 439 session closes, and a phase failure for placement 440: `websocket closed before ready ... 1011 core.internal_error`. The runner had already entered the next nemesis case, but that case only placed on 9 shards because shard-fly-iad-1 had left the registry, so the retry is invalid as release evidence.

Root cause is now narrower than the earlier workflow/RocksDB saturation guess. Shard-fly-iad-1 machine `2872d67f64e6e8` stopped cleanly at `2026-05-29T00:32:26Z` after logs reported RocksDB commit failures with `No space left on device` under `/data/rivet-engine/db/000136.log`. Disk inspection showed the shared `/data` volume was 100% full, but RocksDB itself was only 26 MB; `/data/observability` consumed 19 GB, led by an 18 GB local `signals-2026-05-28.jsonl` from `PAX_OBSERVABILITY=buffer`. The other shard volumes were already 60-76% full, mostly from the same local observability files, so another retry would likely fail again without changing the sink/retention path.

Stopped the invalid retry wrapper PID 3282 and monitor PID 3313, pulled `/data/phase-5/soak/ivm-20260529T001941Z`, and summarized it locally. Since the Better Stack source token and ingest host are now present in Infisical and deployed as Fly secrets on the runtime apps, switched `fly.shards.toml`, `fly.control.toml`, and `fly.driver.toml` from `PAX_OBSERVABILITY=buffer` to `PAX_OBSERVABILITY=on` so the next deployment uses the bounded Better Stack disk buffer instead of unbounded local JSONL files.

## 2026-05-28 17:52 PDT

Corrected the Better Stack credential shape. The user-provided value was a valid Better Stack Telemetry API token, not a source ingest token; using it as `BETTERSTACK_SOURCE_TOKEN` made Vector's Better Stack sink return `401 Unauthorized`. Created a dedicated `pax-backend-v1-soak` Vector source through the Telemetry API, waited for it to accept smoke events with `202 Accepted`, stored the original token as `BETTERSTACK_API_TOKEN`, and updated `BETTERSTACK_SOURCE_TOKEN` plus `BETTERSTACK_INGESTING_HOST` in Infisical and Fly secrets for `pax-backend-shards`, `pax-backend-control`, and `pax-backend-driver`.

Applied the `PAX_OBSERVABILITY=on` configs with the existing Fly images, then cleaned every shard volume's stale `/data/observability/*.jsonl` files. Disk baseline is now 2-3% used per 20 GB shard volume with zero local observability JSONL files. The deploy briefly reset every shard machine's per-machine env to `PAX_SHARD_ID=shard-fly-iad-1`; reran `PAX_SHARD_CHILD_RUNNER_KIND=ivm scripts/fly/scale-shards.sh 10`, which restored distinct `shard-fly-iad-1` through `shard-fly-iad-10` identities and internal machine URLs.

Preflight is green again after clearing the stale drain flag on `shard-fly-iad-2`: `/admin/shards` reports 10 healthy accepting shards, `totalActive=0`, and all control/router/gateway plus per-shard parent `:7700/metrics` and engine `:6430/metrics` endpoints answer from the driver. The next retry can start from a clean registry and disk baseline.

## 2026-05-28 17:55 PDT

Launched the next detached heartbeat `ivm` retry at `/data/phase-5/soak/ivm-20260529T005416Z`. The run wrapper is PID 968 and the detached monitor is PID 1007. The first monitor snapshot at `2026-05-29T00:55:32.626Z` found the process alive, no `exit.code`, the no-faults history started in `seed-fixtures`, and all 10 shards healthy, accepting wakes, and empty.

Closed the code-side fallback gap that let this failure mode happen. `PAX_OBSERVABILITY=buffer` now starts a local pruner that enforces `PAX_VECTOR_LOCAL_BUFFER_MAX_BYTES` (default 512 MiB) across local JSONL buffer sinks, and the observability desired-state doc now calls buffer mode an offline/dev fallback rather than scale-soak evidence. Verification: `bash -n scripts/observability/start-vector.sh scripts/observability/prune-local-buffer.sh`, a local three-file prune smoke, and `git diff --check`.

## 2026-05-28 18:01 PDT

Second detached monitor snapshot for `/data/phase-5/soak/ivm-20260529T005416Z` landed at `2026-05-29T01:00:32.778Z`. The run and monitor processes were alive with no `exit.code`; no-faults was in `open-sessions` with 180 monitor placements across all 10 shards, zero workload failures, zero session closes, zero session errors, and 10 healthy accepting shards with 179 active games. A local pull immediately after caught 200 placements, still across all 10 shards, with `gates_ok=true`.

## 2026-05-28 18:06 PDT

Third detached monitor snapshot landed at `2026-05-29T01:05:32.899Z`. The run and monitor processes remained alive with no `exit.code`; no-faults was still in `open-sessions` with 377 monitor placements across all 10 shards, zero workload failures, zero session closes, zero session errors, and 10 healthy accepting shards with 376 active games. A local pull immediately after caught 400 placements, still across all 10 shards, with `gates_ok=true`.

## 2026-05-28 18:12 PDT

Fourth detached monitor snapshot landed at `2026-05-29T01:10:33.021Z`. The run and monitor processes remained alive with no `exit.code`; no-faults was still in `open-sessions` with 574 monitor placements across all 10 shards, zero workload failures, zero session closes, zero session errors, and 10 healthy accepting shards with 573 active games. A local pull immediately after caught 620 placements, still across all 10 shards, with four clean monitor snapshots and `gates_ok=true`.

A disk spot check across all 10 shard machines showed `/data` still only 2-3% used, `/data/observability` at 4096 bytes, and zero local JSONL files per shard. That confirms the Better Stack-backed run is no longer accumulating the unbounded local observability files that filled shard-fly-iad-1 during the previous retry.

## 2026-05-28 18:16 PDT

Fifth detached monitor snapshot landed at `2026-05-29T01:15:33.150Z`. The run remained alive with no `exit.code`; no-faults was still in `open-sessions` with 770 monitor placements across all 10 shards, zero workload failures, zero session closes, zero session errors, and 10 healthy accepting shards with 769 active games. The local pull immediately after caught 804 placements, still across all 10 shards, with five clean monitor snapshots and `gates_ok=true`.

## 2026-05-28 18:22 PDT

Sixth detached monitor snapshot landed at `2026-05-29T01:20:33.272Z`. The run remained alive with no `exit.code`; no-faults was still in `open-sessions` with 966 monitor placements across all 10 shards, zero workload failures, zero session closes, zero session errors, and 10 healthy accepting shards with 965 active games.

The local pull immediately after caught the target transition: 1000 placements across all 10 shards, `open-sessions` completed after 1,530,038 ms, `send-json` started, and the in-progress summary remained `gates_ok=true`. A direct control-plane registry snapshot then showed 10 accepting shards, `total_active_games=1000`, and 99-102 active games per shard.

## 2026-05-28 18:26 PDT

Seventh detached monitor snapshot landed at `2026-05-29T01:25:33.345Z`. The run remained alive with no `exit.code`; no-faults was in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported seven clean monitor snapshots, 1000 placements across all 10 shards, and `gates_ok=true`.

Post-hold-entry spot checks stayed clean. All 10 shard volumes were still 3% used with `/data/observability` at 4096 bytes and zero local JSONL files. A driver-side metrics sweep passed for control `:9070`, router `:9080`, gateway `:9081`, and parent `:7700` plus engine `:6430` on every shard machine.

## 2026-05-28 18:31 PDT

Eighth detached monitor snapshot landed at `2026-05-29T01:30:33.467Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported eight clean monitor snapshots and `gates_ok=true`.

## 2026-05-28 18:36 PDT

Ninth detached monitor snapshot landed at `2026-05-29T01:35:33.564Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported nine clean monitor snapshots and `gates_ok=true`.

## 2026-05-28 18:41 PDT

Tenth detached monitor snapshot landed at `2026-05-29T01:40:33.664Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported ten clean monitor snapshots and `gates_ok=true`.

## 2026-05-28 18:46 PDT

Eleventh detached monitor snapshot landed at `2026-05-29T01:45:33.788Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported eleven clean monitor snapshots and `gates_ok=true`.

Storage remained controlled during the hold: shard-fly-iad-1 was at 4% `/data` usage, the other nine shard volumes were at 3%, every `/data/observability` directory was still 4096 bytes, and every shard had zero local JSONL files.

## 2026-05-28 18:51 PDT

Twelfth detached monitor snapshot landed at `2026-05-29T01:50:33.824Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported twelve clean monitor snapshots and `gates_ok=true`, putting the retry roughly 29 minutes into the 1000-game no-faults hold.

## 2026-05-28 18:56 PDT

Thirteenth detached monitor snapshot landed at `2026-05-29T01:55:33.929Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported thirteen clean monitor snapshots and `gates_ok=true`, putting the retry roughly 34 minutes into the 1000-game no-faults hold.

## 2026-05-28 19:02 PDT

Fourteenth detached monitor snapshot landed at `2026-05-29T02:00:33.957Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported fourteen clean monitor snapshots and `gates_ok=true`, putting the retry roughly 39 minutes into the 1000-game no-faults hold.

## 2026-05-28 19:06 PDT

Fifteenth detached monitor snapshot landed at `2026-05-29T02:05:33.984Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported fifteen clean monitor snapshots and `gates_ok=true`, putting the retry roughly 44 minutes into the 1000-game no-faults hold.

## 2026-05-28 19:12 PDT

Sixteenth detached monitor snapshot landed at `2026-05-29T02:10:34.021Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported sixteen clean monitor snapshots and `gates_ok=true`, putting the retry roughly 49 minutes into the 1000-game no-faults hold.

## 2026-05-28 19:17 PDT

Seventeenth detached monitor snapshot landed at `2026-05-29T02:15:34.053Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported seventeen clean monitor snapshots and `gates_ok=true`, putting the retry roughly 54 minutes into the 1000-game no-faults hold.

## 2026-05-28 19:23 PDT

Eighteenth detached monitor snapshot landed at `2026-05-29T02:20:34.175Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported eighteen clean monitor snapshots and `gates_ok=true`, putting the retry roughly one hour into the 1000-game no-faults hold.

One-hour spot checks stayed green. Storage remained bounded with shard-fly-iad-1 and shard-fly-iad-7 at 4% `/data` usage, the other eight shard volumes at 3%, every `/data/observability` directory still 4096 bytes, and zero local JSONL files on every shard. A driver-side metrics sweep passed for control `:9070`, router `:9080`, gateway `:9081`, and parent `:7700` plus engine `:6430` on every shard machine.

## 2026-05-28 19:29 PDT

Nineteenth detached monitor snapshot landed at `2026-05-29T02:25:34.237Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported nineteen clean monitor snapshots and `gates_ok=true`, putting the retry roughly 64 minutes into the 1000-game no-faults hold.

## 2026-05-28 19:34 PDT

Twentieth detached monitor snapshot landed at `2026-05-29T02:30:34.359Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported twenty clean monitor snapshots and `gates_ok=true`, putting the retry roughly 69 minutes into the 1000-game no-faults hold.

## 2026-05-28 19:39 PDT

Twenty-first detached monitor snapshot landed at `2026-05-29T02:35:34.481Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported twenty-one clean monitor snapshots and `gates_ok=true`, putting the retry roughly 74 minutes into the 1000-game no-faults hold.

## 2026-05-28 19:44 PDT

Twenty-second detached monitor snapshot landed at `2026-05-29T02:40:34.545Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported twenty-two clean monitor snapshots and `gates_ok=true`, putting the retry roughly 79 minutes into the 1000-game no-faults hold.

## 2026-05-28 19:49 PDT

Twenty-third detached monitor snapshot landed at `2026-05-29T02:45:34.665Z`. The run remained alive with no `exit.code`; no-faults was still in `send-json` with 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported twenty-three clean monitor snapshots and `gates_ok=true`, putting the retry roughly 84 minutes into the 1000-game no-faults hold.

## 2026-05-28 20:02 PDT

Switched from per-monitor commits to 15-minute checkpoint commits after the 23rd clean monitor; the detached driver monitor still writes every five minutes, and pulls preserve every line. Monitor snapshots 24, 25, and 26 landed at `2026-05-29T02:50:34.794Z`, `2026-05-29T02:55:34.858Z`, and `2026-05-29T03:00:34.905Z`. All three were clean: process alive, no `exit.code`, 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported 26 clean monitor snapshots and `gates_ok=true`, putting the retry roughly 99 minutes into the 1000-game no-faults hold.

## 2026-05-28 20:17 PDT

The next 15-minute checkpoint stayed green. Monitor snapshots 27, 28, and 29 landed at `2026-05-29T03:05:34.933Z`, `2026-05-29T03:10:35.054Z`, and `2026-05-29T03:15:35.177Z`. All three showed the run alive with no `exit.code`, no-faults in `send-json`, 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported 29 clean monitor snapshots and `gates_ok=true`, putting the retry roughly 114 minutes into the 1000-game no-faults hold.

## 2026-05-28 20:32 PDT

The `03:30Z` 15-minute checkpoint stayed green. Monitor snapshots 30, 31, and 32 landed at `2026-05-29T03:20:35.301Z`, `2026-05-29T03:25:35.334Z`, and `2026-05-29T03:30:35.457Z`. All three showed the run alive with no `exit.code`, no-faults in `send-json`, 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported 32 clean monitor snapshots and `gates_ok=true`, putting the retry roughly 129 minutes into the 1000-game no-faults hold.

## 2026-05-28 20:47 PDT

The `03:45Z` 15-minute checkpoint stayed green. Monitor snapshots 33, 34, and 35 landed at `2026-05-29T03:35:35.511Z`, `2026-05-29T03:40:35.545Z`, and `2026-05-29T03:45:35.603Z`. All three showed the run alive with no `exit.code`, no-faults in `send-json`, 1000 placements, 1000 active games, all 10 shards healthy and accepting wakes, zero workload failures, zero session closes, zero session errors, and no monitor parse errors. The pulled local summary reported 35 clean monitor snapshots and `gates_ok=true`, putting the retry roughly 144 minutes into the 1000-game no-faults hold.

## 2026-05-28 21:28 PDT

The Better Stack-backed `ivm` retry at
`/data/phase-5/soak/ivm-20260529T005416Z` failed during the no-fault
`send-json` hold, roughly 159 minutes after hold entry. The final pulled
summary now records `run_exit_code=134`, forty monitor snapshots, one workload
failure, 1000 placements, and `gates_ok=false`. The verifier also fails, as
expected, because only the no-fault case started, no result file was written,
`send-json` never completed, and the shard-death/API-partition cases were never
reached.

The immediate workload failure was at `2026-05-29T04:00:32.807Z`: session
`ses_d37f9f1726774b6fb4767ea48ddc3465` for game `...-215/player-a` was already
closing (`readyState=2`) when the runner tried to send the next steady-state
message. Monitor snapshot `04:00:35.952Z` still saw the runner process alive,
but `/admin/shards` had dropped to nine rows and 899 active games; the missing
row was `shard-fly-iad-9`. By `04:05:36.066Z`, cleanup had restored all ten
shard rows with zero active games; by `04:10:36.190Z`, the runner had exited
with code `134`.

This is not the previous local-buffer disk-fill failure. Shard 9 machine
`48e64d3c0401d8` stayed `started`, Fly reported no restart event, `/data` was
only 4% used, `/data/observability` was 4096 bytes, and there were zero local
observability JSONL files. The placement and close mapping is exact: shard 9
owned 101 placements, and all 101 non-abort client closes mapped to those shard
9 placements (`57` code `1011/guard.websocket_service_timeout`, `44` code
`1006`). The other 899 sessions were normal `scenarioRunnerAbort` cleanup.

Tigris history archive evidence narrows the failure to the IVM child/actor
resource path on shard 9. In the `03:58Z-04:02Z` window, shard 9 emitted 237
`onCapacityWarning.sent` memory warnings, rising from about 136.4 MB to 144.3 MB
against the 128 MiB limit. It then emitted 52 `child.handlerError` events and
52 matching `compute.budget.rejected` events for `cpu-ms-per-tick`; the common
current usage was about 12.34s against a 10s tick limit, with four cases around
56.9s. The first error was at `2026-05-29T04:00:44.938Z` for game `...-398`:
`ws.send timed out after 30000ms`. Shard history then recorded 101
`actor.stop`, 101 `onSleep.sent`, and 101 `session.closed` events as the shard
drained. Game `...-215` last completed a message at `03:59:32.812Z`; it had no
successful `04:00Z` message, then stopped at `04:01:33.565Z` and recorded its
shard-side session close at `04:01:43.581Z`.

The next retry should not start until the shard 9 resource-saturation path is
addressed. Better Stack shipping and local buffer control are now working, but
the 100-games-per-shard IVM steady-state profile can still push the child path
past memory warning and CPU tick limits, stall websocket sends, trip gateway
service timeouts, and temporarily remove the shard from the control-plane
registry.

Applied the first targeted fix for this failure family. The parent actor was
reporting `memory-bytes` from the shard parent process RSS, not from the
per-game child process RSS. At 100 games per shard, that made every child see
the shared parent process crossing the 128 MiB budget and receive repeated
`onCapacityWarning` handlers during steady-state traffic. `memory-bytes` now
reads `/proc/<child-pid>/statm` for the child RSS and falls back to `0` when the
child is unavailable or procfs cannot be read. Verification:
`pnpm --filter @pax-backend/parent-actor check-types` and `git diff --check`.

## 2026-05-28 21:49 PDT

Closed a driver-side soak-memory risk before the next retry. The failed
`ivm-20260529T005416Z` run also ended with the scenario-runner process hitting
the Node heap limit after the shard failure, so the metrics collector now keeps
256 scalar samples per series by default instead of 2048 while still allowing
`PAX_METRICS_SCALAR_RESERVOIR_SAMPLES` to raise the reservoir for targeted
debug runs. This keeps long-soak percentile attribution useful without holding
as much per-series JS heap across ten shard metric surfaces. Verification:
`pnpm --filter @pax-backend/scenario-runner check-types` and `git diff --check`.

## 2026-05-28 21:59 PDT

Deployed the child-RSS parent actor fix to `pax-backend-shards` as
`deployment-01KSS025RW6DW5FD3HBNTMGHQ0` / release version 11. As expected, the
deploy reset every shard machine to the app-level `shard-fly-iad-1` env; reran
`PAX_SHARD_CHILD_RUNNER_KIND=ivm scripts/fly/scale-shards.sh 10`, which
restored distinct `shard-fly-iad-1` through `shard-fly-iad-10` identities and
internal URLs. Verification from the driver showed `/admin/shards` at 10
healthy accepting shards with `activeGames=0`, and a live shard grep showed
`childRssBytes` in both `/app/runtime/parent-actor/dist/parent.mjs` and
`/app/runtime/parent-actor/src/parent.mts`.

Deployed the scenario-runner metric reservoir guard to `pax-backend-driver` as
`deployment-01KSS1AA08S6N0VF9KB0BT37FD` / release version 12. Verified the
driver image contains `SCALAR_SERIES_RESERVOIR_SAMPLES` with the default 256
sample cap, then checked control/router/gateway metrics and all 20 per-shard
parent/engine metrics endpoints from the driver.

Started a detached target-density validation from driver machine
`1854539b257768` at
`/data/phase-5/validation/ivm-v1scale-20260529T045623Z`, wrapper PID `822`.
It runs the existing `testing/scale-ladders/v1-scale.mts` `1000g-10shards`
rung with `ivm`, a 1536 MiB Node old-space cap, the same pinned internal
control/router/gateway URLs, and per-shard metrics labels. The no-fault case is
first; the launch check found the wrapper alive, the no-fault history file
created, and the shard registry still at 10 healthy accepting empty shards.

## 2026-05-28 22:38 PDT

The post-fix `ivm` target-density validation reached 1000 placements and
entered the no-fault heartbeat hold. The no-fault case completed
`open-sessions` at `2026-05-29T05:25:32.982Z` after 1,543,212 ms, then started
`send-json`. The checkpoint showed the wrapper still alive, 1000 placements,
zero workload failures, zero runner-side session closes, zero
`onCapacityWarning.sent` events, and all 10 shards healthy and accepting wakes
with 98-102 active games each. The scenario-runner Node process was still about
179 MB RSS, so the driver-side reservoir cap is not showing early heap growth.

## 2026-05-28 22:42 PDT

Added a lightweight remote monitor for
`/data/phase-5/validation/ivm-v1scale-20260529T045623Z`; it appends five-minute
status lines to `monitor/status.tsv` and preserves matching `/admin/shards`
snapshots. The first monitor line at `20260529T053952Z` had the runner alive,
1000 placements, zero failures, zero closes, zero capacity warnings, and zero
budget rejects. Pulled the validation directory locally to
`var/phase-5/validation/ivm-v1scale-20260529T045623Z` and summarized it with
`scripts/fly/summarize-soak.mts`; the partial summary is green with one
in-progress no-fault case, 1000 placements, all 10 placement shards, no parse
errors, and no failing/error cases.

Because runner history does not include shard-local parent events until archive
collection, checked `/data/history/history.jsonl` directly on all 10 shard
machines for the current run prefix. Every shard reported
`onCapacityWarning.sent=0` and `compute.budget.rejected=0`, which is the direct
target-density evidence for the child-RSS fix during the no-fault hold.

## 2026-05-28 22:45 PDT

Tightened the validation artifact summarizer while the hold continued.
`scripts/fly/summarize-soak.mts` now treats `monitor/status.tsv` as a supported
fallback when the older `monitor/status.jsonl` is absent, parses the latest
`alive`, `exit`, placement, failure, close, capacity-warning, and budget-reject
counters, and joins the matching `monitor/shards-<timestamp>.json` snapshot for
last shard count and active games. Verification: `git diff --check`,
`pnpm typecheck`, and a summary over
`var/phase-5/validation/ivm-v1scale-20260529T045623Z` showing two monitor
snapshots, 10 shards, 1000 active games, zero failures, zero closes, zero
capacity warnings, and zero budget rejects.

## 2026-05-28 22:51 PDT

Third remote monitor line for the post-fix validation landed at
`20260529T054952Z`, about 24 minutes into the no-fault `send-json` hold. The
line stayed clean: runner alive, no `exit.code`, 1000 placements, zero workload
failures, zero runner-side session closes, zero capacity warnings, and zero
budget rejects. The simultaneous registry check still had 10 healthy accepting
shards and exactly 1000 active games with the same 98-102 per-shard
distribution.

## 2026-05-28 23:10 PDT

Refreshed the local copy of
`/data/phase-5/validation/ivm-v1scale-20260529T045623Z` while the no-fault
hold continued. The partial validation summary now covers six remote monitor
snapshots through `20260529T060452Z`: wrapper alive, 1000 placements across all
10 shards, 1000 active games in the latest shard snapshot, zero workload
failures, zero runner-side session closes, zero capacity warnings, zero budget
rejects, and no history or monitor parse errors. This is still short
target-density validation, not the 24-hour exit soak.
