# Phase 3 scratchpad

Append-only timestamped ledger for this phase. Each entry captures what was done, what worked, what didn't, and any design decisions made along the way. The dead ends in particular are the most valuable thing this log carries forward — write them down with the reasoning, not just the outcome.

Design decisions belong here especially. If the desired final shape in [`docs-next/`](../../docs-next/) had to be tweaked, if a new [`docs-next/why/`](../../docs-next/why/) page was needed, if a judgment call resolved an ambiguity, or if a workstream got reshaped mid-execution — log it here with rationale. The reasoning is more durable than the conclusion.

Format suggestion: a `## YYYY-MM-DD HH:MM` heading per entry, followed by prose covering what was done, what worked, what didn't, and any design decisions. Not enforced; pick whatever shape keeps the log readable.

---

## 2026-05-28 08:44 PDT

Started Phase 3 after re-reading the roadmap directive/exit signal, [`docs-next/proofs/historia-default.md`](../../docs-next/proofs/historia-default.md), and [`examples/bundles/historia-default/README.md`](../../examples/bundles/historia-default/README.md). The five URL service spec files already exist as schema-only docs, but the bundle directory is still README-only and the scenario/oracle suite has not been authored.

Initial work split: audit the URL-service fixture contracts first, then land the bundle scaffold/build shape, then port core state/blob/migration code, modules/workflows, routing/hydration/policy gates, scenarios/oracles, and finally the local/Fly proof run. Keep Pax-historia-specific logic contained under `examples/bundles/historia-default/` and the schema-only URL-service examples; substrate zones stay generic.

## 2026-05-28 08:47 PDT

Finished the URL service spec audit. The five schema-only specs already covered the proof's required kinds and stayed outside substrate internals; the gaps were around fixture authoring rather than application schema. `examples/url-services/README.md` now lists the historia specs and states the replay fixture contract: fixtures are gateway `api.invoke` wire records with a `fingerprint`, `statusCode`, and serialized `rawInbound`, not plain URL-service result files. This matters because the replay store looks inside each record and hard-fails `replayCoverageGap` on missing fingerprints.

Two smaller spec fixes landed with that audit: `participation.v1` now names the real scenario-runner phase as `send-host-events`, and `ai.chat.v1` represents streamed provider output as deterministic JSON `streamEvents` in proof fixtures instead of a live `ReadableStream`, since the gateway buffers URL-service HTTP responses as JSON.

## 2026-05-28 08:51 PDT

Landed the `historia-default` bundle scaffold. The package now has `package.json`, `tsconfig.json`, root `manifest.ts`, `src/ambient.d.ts`, and `src/index.mts`. The manifest produces `historia:v5` and accepts the full `historia:v1` through `historia:v5` chain. The entrypoint deliberately stays shallow: it logs lifecycle activity, tracks connected sessions, sends a `historia.ready` connect message, echoes unhandled player messages as `historia.unhandled`, and broadcasts host events. State/blob/migrations remain the next task rather than being hidden inside the scaffold.

Verification: initial package-local typecheck failed because the new workspace package had no pnpm node_modules link yet; `pnpm install --offline` added the lockfile importer and local link without downloading dependencies. After that, `pnpm --filter @pax-backend/bundle-historia-default check-types` and `pnpm --filter @pax-backend/bundle-historia-default build` both passed.
