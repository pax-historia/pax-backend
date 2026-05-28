# `orchestration/placement-router/`

HTTP placement + signed JWT. Reads the active-game directory in Redis, picks
the coldest healthy shard whose `runtimeContractsSupported` includes the
game's `bundle.runtimeContractRequired`, signs a short-lived JWT, returns it
to the client. Client then opens WS direct to the shard (router is **not** in
the WS path).

Step 3 of the plan's kickoff: port verbatim from
[pax-sharded-spike/orchestration/router-placement/](../../../pax-sharded-spike/orchestration/router-placement/),
then add the contract-version placement gate (Strong Platform Guarantee #16).

Stub.
