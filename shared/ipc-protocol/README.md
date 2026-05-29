# `shared/ipc-protocol/` — `@pax-backend/ipc-protocol`

Versioned runtime bridge schema shared by the Broker, Runner pool, SDK,
orchestration services, tests, and placement/router directory consumers.
The canonical wire reference is
[`docs-next/reference/ipc-protocol.md`](../../docs-next/reference/ipc-protocol.md).

## What's here

- `RUNTIME_CONTRACT_VERSION` and `IPC_VERSION` constants.
- `BridgeEnvelope<T, P>` plus `bridgeEnvelope(...)` for game-scoped,
  request-id based Broker ↔ Runner messages.
- `RunnerControlEnvelope<T, P>` for process-level Runner messages such as
  `runner.ready`.
- Exhaustive channel catalogs: `BROKER_TO_RUNNER` and `RUNNER_TO_BROKER`.
- Primary discriminated unions: `BrokerToRunnerEnvelope` and
  `RunnerToBrokerEnvelope`.
- Assignment, lifecycle, storage, blob, websocket, API, budget, log,
  metrics, handler, isolate-counter, and fatal-error payload types.
- Redis key prefixes, TTLs, bundle/game/directory rows, and id generators
  consumed outside the runtime package boundary.

## Trust stance

The Broker stamps identity. Runner-originated game messages carry `gameId`
for multiplexing, but the Broker accepts them only when that game is
assigned to the originating Runner. Runner payloads never authoritatively
assert `sessionId`, `playerId`, connected sessions, gateway context, or
credentials.

## Legacy aliases

`ParentToChildEnvelope`, `ChildToParentEnvelope`, `PARENT_TO_CHILD`,
`CHILD_TO_PARENT`, and `envelope(...)` are compatibility exports for the
old parent-actor and per-game child-runner packages while Phase 7 migrates
their implementation. New code should use the Broker/Runner names above.

## Evolution rule

This package changes when the substrate-runtime contract evolves (Axis A).
Adding or changing a channel requires:

1. Updating the payload type and envelope union.
2. Updating `BROKER_TO_RUNNER` or `RUNNER_TO_BROKER`.
3. Bumping `RUNTIME_CONTRACT_VERSION`.
4. Updating the Broker dispatcher and both Runner implementations.
5. Updating the docs-next wire reference in the same change.
