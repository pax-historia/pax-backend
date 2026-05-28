# History events

> Layer: **Contract**

The substrate emits a structured event for every channel call, every
lifecycle transition, every session edge, every shard event, every
`api.invoke` wire round trip, every bundle gate decision, every placement
decision, every rollback decision, and every compute event.

This page is the conceptual surface. The exhaustive event-name and
required-fields catalog lives in
[`reference/event-schema.md`](../reference/event-schema.md).

## Why history is contract, not just observability

The history stream is the substrate's authoritative narration of itself.
**Every strong platform guarantee oracle reads from history.** If history
is incomplete, oracle results are uninterpretable. That makes history
**part of the contract** — the substrate commits to emitting specific
events in specific shapes, just like it commits to emitting specific
lifecycle hooks.

Guarantee #14 (history completeness) is the meta-guarantee: it asserts
that every channel call has a matching history event and that `pax_seq`
has no gaps.

## Format

History is JSONL (one JSON object per line). Required fields on every
event:

| Field | Type | Notes |
|---|---|---|
| `event` | string | The event name; kebab-or-dot-cased; categorized in [`reference/event-schema.md`](../reference/event-schema.md) |
| `ts` | string (ISO 8601 with ns precision) | When the substrate observed |
| `shardId` | string | Which shard emitted |
| `pax_seq` | positive integer | Monotonic per shard; persists across restart |

Event-specific fields are required per the schema; see
[`reference/event-schema.md`](../reference/event-schema.md). Common
optional fields:

| Field | When present |
|---|---|
| `gameId` | Any game-scoped event |
| `sessionId` | Any session-scoped event |
| `playerId` | Any player-scoped event |
| `traceId` | Any event that arose from a trace-carrying boundary |
| `runId` | Scenario-runner runs only |
| `requestId` | API gateway events |
| `bundleName` | Bundle-scoped events |
| `bundleCompatTag` | Bundle-scoped events |

## Event categories

Eight categories cover everything:

| Category | Example events | What they record |
|---|---|---|
| **Lifecycle** | `onWake.sent`, `onWake.succeeded`, `onWake.failed`, `onSleep.sent`, `onSleep.completed`, `actor.start`, `actor.stop`, `child.exit`, `child.restart` | Process and bundle lifecycle |
| **Session** | `session.opened`, `session.closed`, `session.forceDisconnect`, `connection.refused` | WS session edges |
| **Player I/O** | `onPlayerMessage`, `ws.send`, `ws.send.rejected` | Per-message I/O |
| **Storage** | `state.read`, `state.write`, `state.flush`, `blob.put`, `blob.get`, `blob.delete`, `blob.list`, `*.rejected` variants | All `c.state` and `c.blob` operations |
| **API** | `api.invoke.request`, `api.invoke.response`, `api.invoke.wire` | Every `c.api.invoke` round trip and its wire bytes |
| **Compute** | `compute.budget`, `compute.budget.rejected`, `onCapacityWarning.sent`, `child.handlerComplete`, `child.handlerError` | Compute budget consumption + violations |
| **Bundle** | `bundle.uploaded`, `bundle.loaded`, `bundle.flip.refused`, `bundle.flip.succeeded`, `bundle.coldWake.rejected`, `bundle.rollback.*` | Bundle lifecycle and gate decisions |
| **Topology** | `placement.accepted`, `placement.refused`, `game.created`, `game.deleted`, `player.deleted`, `shard.registered`, `shard.drain.started`, `shard.drain.completed`, `onHostEvent.received`, `onHostEvent.delivered` | Cluster-level events |

## Persistence

History is tiered:

| Tier | Storage | Use |
|---|---|---|
| **In-process** | Ring buffer of last N events per parent | `GET /admin/games/:id/snapshot` (cheap) |
| **Per-shard** | Append-only `var/history.jsonl` on the shard machine | Local oracle reads; smoke-bot tail |
| **Cross-shard durable** | Tigris under `history/<shardId>/<runId or date>/<chunk>.jsonl.zst` | Long-term oracle replay; cross-machine queries |
| **Live stream** | `GET /admin/history` from the control plane via Tigris-backed cursor pagination | Vercel-backend tail/poll |

The Vector sidecar ships per-shard files to Tigris on rotation; the
control plane serves cursor-paginated reads from Tigris.

## Causal ordering

Within a single shard, `pax_seq` is monotonic with no gaps. Oracles
that need cross-event causal ordering on a single shard rely on
`pax_seq` directly.

Across shards, ordering is by `(ts, shardId, pax_seq)` lexicographic.
Two shards may emit events with the same `ts` but `pax_seq` is unique
per shard so there is no ambiguity within a shard.

`traceId` provides cross-process ordering for events arising from the
same request. `traceId` is set at the placement-router edge for any
WS-originated flow and propagates through JWT claims, WS handshake,
IPC envelope, and gateway envelope.

## What the bundle can emit into history

Bundles can emit their own log/metric events via `c.log.emit` and
`c.metrics.emit`. These show up in history with `event: 'log.emit'` or
`event: 'metrics.emit'` and carry the bundle's payload verbatim under a
`payload` field, plus substrate-stamped correlation fields.

The substrate adds `source: 'creator'` or `source: 'console'` (for
proxied `console.*` calls) to distinguish bundle-emitted events from
substrate-emitted events.

## What history does **not** contain

- The bundle's internal JavaScript variables (only what hits a channel
  or `c.log` is recorded).
- The verbatim `c.state` or `c.blob` value on every write (the size and
  fingerprint are recorded; the contents live in Tigris).
- The vercel backend's URL service internals (the substrate records the
  HTTP envelope, not what happens inside the URL service).
- Anything billing-shaped that didn't come through a substrate channel.

## Cross-references

- [`reference/event-schema.md`](../reference/event-schema.md) — full
  event name + required-fields catalog
- [`vision/guarantees.md`](../vision/guarantees.md) #14
- [`subsystems/parent-actor.md`](../subsystems/parent-actor.md) — the
  writer
- [`subsystems/observability.md`](../subsystems/observability.md) — how
  history fits the broader observability story
- [`subsystems/scenario-runner.md`](../subsystems/scenario-runner.md) —
  history is the oracle interface
