# `orchestration/placement-router/`

HTTP placement + signed JWT. Reads the active-game directory in Redis, picks
the coldest healthy shard whose `runtimeContractsSupported` includes the
game's `bundle.runtimeContractRequired`, signs a short-lived JWT, returns it
to the client. Client then opens WS direct to the shard (router is **not** in
the WS path).

Current source passes include the smoke-grade Redis router, the
`runtimeContractRequired ∈ runtimeContractsSupported` gate, and placement
responses/error details that expose the required contract and selected shard
range so the scenario-runner can record `placement.accepted` /
`placement.rejected` history.

Still pending: production stickiness, atomic wake claims, recent-wake
accounting, metrics, and direct actor-create calls.
