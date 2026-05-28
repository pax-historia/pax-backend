# `shared/ipc-protocol/` — `@pax-backend/ipc-protocol`

Versioned IPC schema shared across the parent actor, both child runners,
the SDK, the smoke bot, and the Rust placement router's mental model of
the Redis row layout. Channel payload shapes are **fixed by the bundle's
`runtimeContractRequired`**; no in-band version field on payloads. The
shard knows the contract version from the bundle's manifest before any
payload is parsed (see [plan](../../README.md) §"Communication channels"
and §"Bundle compatibility").

Lives in `shared/` rather than `runtime/` because multiple zones consume
the same types (parent and child in `runtime/`, smoke bot in
`testing/`, manifest types re-exported by `sdk/runtime-sdk/`, Redis row
schemas mirrored on the Rust side of `orchestration/placement-router/`).
See [`../README.md`](../README.md) for the zone's broader rules.

## What's here

- `IPC_VERSION` and `RUNTIME_CONTRACT_VERSION` integer constants.
- The `IpcEnvelope<T, P>` shape plus an `envelope(type, payload)` helper.
- `ParentToChildEnvelope` and `ChildToParentEnvelope` as **discriminated
  unions** tagged on `.type` — switches over them must be exhaustive
  (TypeScript catches a missed channel at compile time via the
  `_exhaustive: never` guard).
- Lifecycle payload types: `OnWakePayload`, `OnSleepPayload`,
  `OnPlayerConnectPayload`, `OnPlayerDisconnectPayload`,
  `OnPlayerMessagePayload`, `OnCapacityWarningPayload`.
- Child-to-parent payload types: `BootstrapPayload`, `WsSendPayload`,
  `LogEmitPayload`, `ChildFatalPayload`, `ChildHandlerErrorPayload`,
  `ChildHandlerCompletePayload`, `ChildUnknownMessagePayload`.
- Parent-to-child response payload types for request/response channels,
  including `WsSendResponsePayload` for typed bandwidth/rate rejections.
- `BootstrapPayload` carries the parent-selected memory limit and
  `handlerTimeoutMs` so child runner enforcement matches the advertised
  `cpu-ms-per-tick` budget.
- Redis key prefixes + TTLs: `ACTIVE_GAMES_KEY_PREFIX`,
  `SHARD_REGISTRY_KEY_PREFIX`, `PLACEMENT_RECENT_WAKES_KEY_PREFIX`,
  `BUNDLE_KEY_PREFIX`, `GAME_KEY_PREFIX`.
- Redis row schemas: `ShardRegistration`, `ActiveGamePlacement`,
  `BundleRecord`, `BundleManifest`, `GameRecord`.
- ID generators: `generateSessionId()` (the `ses_<32 hex>` substrate
  primitive), `generateRunId()`.

## Evolution rule

This package is what changes whenever the substrate-runtime contract
evolves (Axis A in the plan's versioning matrix). Bumps are deliberate
and ship together with a new shard image. Adding a new channel:

1. Add the payload type and the envelope variant.
2. Add the channel name to `PARENT_TO_CHILD` or `CHILD_TO_PARENT`.
3. Bump `IPC_VERSION` and `RUNTIME_CONTRACT_VERSION`.
4. Update the parent's dispatch + the child's handler set — the
   exhaustiveness check at the `default` branch of each `switch` will
   refuse to compile until both sides handle the new channel.
