# `runtime/shard-image/`

Multi-stage Dockerfile that bundles vendored Rivet (from `vendor/rivet/`),
the parent actor, the two child runners, and the IPC protocol into a single
image. Built once per release and rolled across all `pax-backend-shards`
machines (canary one, watch metrics 10–30 minutes, rolling drain-and-replace —
see [plan](../../README.md) §"Production redeploy strategy").

Self-reports `runtimeContractsSupported: [min, max]` to the placement router
at startup (Strong Platform Guarantee #16; see [plan](../../README.md)
§"Bundle compatibility").

Stub. Implementation lands in step 7 of the plan's kickoff.
