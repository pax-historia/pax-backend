# `orchestration/placement-router/`

HTTP placement + signed JWT. Reads the active-game directory in Redis, picks
the coldest healthy shard whose `runtimeContractsSupported` includes the
game's `bundle.runtimeContractRequired`, signs a short-lived JWT, returns it
to the client. Client then opens WS direct to the shard (router is **not** in
the WS path).

Sleeping games are **not pinned to any historical shard.** Because `c.state`
and `c.blob` are Tigris-canonical (see [README](../../../README.md)
§"Storage tiers"), the next wake is a fresh capacity decision; any healthy
shard in range can take the game and cold-wake from storage.

Current source passes include the smoke-grade Redis router, the
`runtimeContractRequired ∈ runtimeContractsSupported` gate, and placement
responses/error details that expose the required contract and selected shard
range so the scenario-runner can record `placement.accepted` /
`placement.rejected` history. `/metrics` exposes Prometheus text counters for
placement requests, accepted placements, router-gate rejections, and runtime
contract gate rejections, plus build info.

Still pending: production stickiness, atomic wake claims, recent-wake
accounting, and direct actor-create calls.
