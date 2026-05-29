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
