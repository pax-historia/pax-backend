# `runtime/ipc-protocol/`

Versioned IPC schema shared across parent actor, both child runners, and the
SDK. Channel payload shapes are **fixed by the bundle's
`runtimeContractRequired`**; no in-band version field on payloads. The shard
knows the contract version from the bundle's manifest before any payload is
parsed (see [plan](../../README.md) §"Communication channels" and §"Bundle
compatibility").

This package is what changes whenever the substrate-runtime contract evolves
(Axis A in the plan's versioning matrix). Bumps are deliberate and ship
together with a new shard image.

Stub. Implementation lands as part of step 7.
