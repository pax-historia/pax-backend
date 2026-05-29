# Phase 8 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-29 03:10 PDT

Opened Phase 8 after Phase 7 verification passed. The next task is the local
build/smoke surface audit: check the current build matrix, local stack scripts,
smoke bot, and audit commands before trying to run `pnpm smoke` on the new
Broker/Runner runtime.

The audit expanded the phase into four execution tasks. First, rebuild active
workspace packages plus router and bundle artifacts after the legacy runtime
path removal. Second, bring up the local Broker/Runner stack and drive
`pnpm smoke` against it without production secrets. Third, rerun dependency
audits (`pnpm audit`, and `cargo audit` if installed) and either fix or log
residual findings. Finally, rerun the Phase 8 exit checks and close the phase.

## 2026-05-29 03:12 PDT

The local build matrix is green. `pnpm -r --if-present run build` completed
for the active workspace after the old parent/child packages were removed.
Then `scripts/build/build-router.sh` produced a release placement-router binary
at `.cache/router/router`, and `scripts/build/build-bundles.sh` rebuilt every
creator bundle under `examples/bundles/*/dist/bundle.js`.

No code changes were needed from the build pass. One attempted
`pnpm -r --if-present run build --dry-run` probe failed because `--dry-run`
was forwarded into `tsc -b`; the real build command above is the useful signal.

## 2026-05-29 03:42 PDT

The local Broker smoke is green. The first runs exposed three runtime issues in
the new Broker/Runner path:

- The shard registry row aged out while the local stack stayed up, so
  `/placement` returned `noEligibleShards`. The Broker now republishes capacity
  on a configurable heartbeat (`PAX_BROKER_CAPACITY_HEARTBEAT_MS`, default
  10s).
- Router placement claimed `active_games:<gameId>` with a generation, but a
  later Broker wake resolved the bundle without that generation and rejected
  the already-claimed game. The Redis bundle resolver now reuses the active
  generation when the current shard owns the row.
- The Runner handled `onPlayerMessage`, but the client never saw the echo
  because Broker fanout wrapped bundle payloads in `{type:"message", body}`.
  Broker fanout now preserves bundle-defined object frame fields and stamps the
  recipient `sessionId`; primitive payloads still fall back to the generic
  `message` wrapper.

The smoke then reached the history assertions. Broker `ws.send` history now
includes `sessionId` and `playerId` when exactly one open recipient is sent, and
`c.log.emit` is recorded as `event: "log.emit"` with the original bundle payload
nested. Verification for this slice: `pnpm typecheck`, `git diff --check`, and
`pnpm smoke` all passed against the local stack.

## 2026-05-29 03:46 PDT

Dependency audit pass is clean. `pnpm audit` reported no known
vulnerabilities. `cargo audit` is installed; the root invocation failed because
this repo does not have a root `Cargo.lock`, so the active Rust surface was
audited directly with:

```sh
cargo audit --file orchestration/placement-router/Cargo.lock
```

That scan loaded the RustSec advisory DB, scanned 197 crate dependencies, and
reported no advisories. Vendored Rivet lockfiles were not audited or edited as
part of this phase, matching the standing `vendor/rivet/` constraint.
