# `runtime/shard-image/`

Multi-stage Dockerfile that bundles the Broker, Runner pool, state store,
runtime SDK, shared IPC protocol, bundles, and Vector into a single shard
image. Built once per release and rolled across all `pax-backend-shards`
machines (canary one, watch metrics 10–30 minutes, rolling drain-and-replace).

Self-reports `runtimeContractsSupported: [min, max]` to the placement router
through Broker capacity rows at startup (Strong Platform Guarantee #16).
