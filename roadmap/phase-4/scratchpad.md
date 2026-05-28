# Phase 4 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-28 10:18 PDT

Started Phase 4 after closing the historia-default proof. Re-read the directive and exit signal: this phase is not about adding more happy paths; it is about actively trying to break the substrate through compromised bundles, race conditions, stolen JWTs, compute-budget edges, partition nemeses, and rolling-deploy collisions. The exit signal is a CI release gate: full scenario suite, every nemesis profile, both `ivm` and `noivm`.

Current inventory before new work: `testing/scenarios/` has `chat-steady-state`, `compute-stress`, and `shard-death-resilience`; `examples/bundles/historia-default/scenarios/` has the ten proof scenarios from Phase 3; `testing/nemeses/` has `no-faults` and `shard-death-every-5m`; CI has smoke/type/deploy workflows but no full scenario-suite release gate. The runner already supports live workloads, scenario-local oracles, delayed Fly history waits, archived history filtering, and nemesis scheduling for `kill-shard`, but it does not yet expose a full catalog x nemesis x runtime matrix as a single release-gate command.

Task split for this phase: first build the runtime/suite matrix foundation, then add adversarial scenarios for compromised bundles/JWTs, compute-budget edges, race/partition/deploy collisions, wire CI as the gate, and finally verify all docs/code touched by the phase.

## 2026-05-28 10:22 PDT

Finished the runtime/suite matrix foundation. The scenario-runner now has suite mode (`--suite <catalog>`) that discovers scenario manifests and nemesis profiles, runs every scenario × nemesis case, writes isolated history/result files, and emits a `suite.result.json` summary tagged with `--runtime ivm|noivm`. The runner still assumes the live stack already matches the requested runtime; the new `scripts/test/scenario-suite-local.sh` provides that local wrapper by restarting the stack once with `PAX_CHILD_RUNNER_KIND=ivm` and once with `PAX_CHILD_RUNNER_KIND=noivm`.

Verification: `pnpm --filter @pax-backend/scenario-runner check-types` passed, `bash -n scripts/test/scenario-suite-local.sh` passed, and a replay-mode smoke over `chat-steady-state × no-faults` produced the expected `suite.result.json` with exit code `2` because the intentionally empty history fails the oracles. That validates the suite CLI/artifact path without starting a long live workload.

## 2026-05-28 10:37 PDT

Started Task 3 with the stolen/misrouted placement-token lane. The parent actor now accepts `placementToken` as the canonical WS query parameter, keeps `token` as a legacy alias, uses `4401` for missing/invalid token material, uses `4403` for wrong-shard/not-allowed refusals, and rejects a token whose `gameId` does not match the actor key selected by the WS URL. That last check closed a real gap: a placement token minted for one game could be replayed against another game where the same player was allowed.

Added `expect-ws-refusals` to the scenario-runner and a new `testing/scenarios/jwt-adversarial` scenario. The scenario requests placement for game 1, rewrites the WS routing key to game 2, and verifies no session opens plus the parent emits `connection.refused` with `reason=wrongGame` and `tokenGameId`. The public WebSocket client sees Rivet guard `1011 guard.websocket_service_unavailable` for this pre-open actor refusal in the local stack, so the scenario accepts either the desired `4403` or the guard-translated `1011` at the socket boundary and treats the parent history event as the typed guarantee. Docs now call out that guard translation caveat.

Verification: `pnpm --filter @pax-backend/scenario-runner check-types`, `pnpm --filter @pax-backend/oracles-lib check-types`, and `pnpm --filter @pax-backend/parent-actor check-types` passed. A live local run with `--oracles scenario` passed and produced `var/phase-4/jwt-adversarial.result.json` with G2, G14, G16, and `G0_jwt_adversarial_refusals` all passing. A prior `--oracles all` run correctly returned nonzero because no-session adversarial histories leave session/compute/durability guarantees inconclusive.

## 2026-05-28 10:45 PDT

Added the compromised-bundle target-refusal lane. The hostile bundle `hostile-ws-target` opens normally, then tries to `c.ws.send` to `intruder-player`, who has no connected session. Before this pass, the parent treated that as success with `sent: 0`; that was silent acceptance. The parent now validates WS send targets and returns typed `targetInvalid` or `targetNotConnected` errors before any frame is sent.

The new `testing/scenarios/compromised-bundle-adversarial` scenario asserts the bundle sees `{ ok: false, error: "targetNotConnected" }`, history records `ws.send.rejected` with the missing target detail, no frame is sent to the missing player, and no parent/child fatal event occurs. Verification: `pnpm typecheck`, `pnpm --filter @pax-backend/bundle-hostile-ws-target check-types`, `pnpm --filter @pax-backend/bundle-hostile-ws-target build`, `git diff --check`, and a live local `--oracles scenario` run all passed.

## 2026-05-28 10:48 PDT

Finished the JWT half of Task 3. `jwt-adversarial` now covers tampered-signature, expired-token, and wrong-game placement-token handshakes. The runner can mutate a placement token by corrupting its signature or re-signing an expired payload with `PAX_JWT_SECRET` (defaulting to the local dev secret). In the local Rivet guard path, all three public clients observed `1011 guard.websocket_service_unavailable`; parent logs confirmed `invalid signature` and `jwt expired`, while wrong-game replay also produced `connection.refused(reason=wrongGame)` history.

Verification: `pnpm --filter @pax-backend/scenario-runner check-types`, `pnpm --filter @pax-backend/oracles-lib check-types`, `git diff --check`, and a live local `jwt-adversarial --oracles scenario` run all passed. The scenario took about 58 seconds because each rejected pre-open WebSocket handshake waits through the guard retry window.

## 2026-05-28 10:58 PDT

Finished the compute-budget edge lane. `compute-stress` is now a deterministic live edge probe that runs the new `budget-edge-probe` bundle against the actual parent/gateway budget enforcers instead of generic churn. The scenario drives `ws-messages-per-sec`, `bandwidth-bytes-per-sec`, `state-bytes`, `blob-keys`, `api-invocations-per-min`, and `cpu-ms-per-tick` to typed refusals. The scenario-local oracle requires the expected rejection events and also checks that every `apiRateExceeded` response has a matching `api.invoke.wire` record with `statusCode: 0`, so the URL service is not contacted after the substrate budget rejects the call.

One supporting runtime fix landed in the same task: local object-store prefix listing now walks the concrete prefix directory when the caller passes a directory-shaped prefix. Without that, hitting the blob-key edge repeatedly in a local dev workspace got slower as old per-game blobs accumulated under unrelated prefixes.

Verification: root `pnpm typecheck`, `git diff --check`, and a live `compute-stress --backend live --oracles scenario` run all passed. The live run used `--game-id-prefix compute-stress-edge-v2` and produced `var/phase-4/compute-stress.result.json` with G1, G5, G7, G8, G11, G12, G14, and `G0_compute_budget_edges` passing.
