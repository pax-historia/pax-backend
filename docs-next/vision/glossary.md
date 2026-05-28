# Glossary

> Layer: **Vision**

Every term used elsewhere in this tree is defined exactly once, here.

## Parties

- **Vercel platform frontend wrapper** — The browser-facing application
  Pax-historia ships on Vercel. See
  [`parties-and-roles.md`](parties-and-roles.md).
- **Vercel backend** — Pax-historia's Next.js server on Vercel. See
  [`parties-and-roles.md`](parties-and-roles.md).
- **Substrate** — This repo. See
  [`parties-and-roles.md`](parties-and-roles.md).
- **Bundle author** — A human who writes a bundle. Not a party in the system,
  a role.

## Substrate-owned units

- **Game** — A running (or sleeping) instance of a bundle, identified by
  `gameId`. Stateful; persists until destroyed. See
  [`subsystems/parent-actor.md`](../subsystems/parent-actor.md).
- **Bundle** — A self-contained creator-authored package containing JS code,
  a manifest, and metadata. Loaded into the child sandbox at wake. Stored in
  substrate-owned object storage. See
  [`subsystems/bundle-storage.md`](../subsystems/bundle-storage.md) and
  [`contract/bundle-compatibility.md`](../contract/bundle-compatibility.md).
- **Manifest** — The bundle's declaration of `compatTagProduced`,
  `compatTagsAccepted`, `runtimeContractRequired`. See
  [`contract/bundle-compatibility.md`](../contract/bundle-compatibility.md).
- **Shard** — A Fly machine running the runtime image. Hosts ≤ N concurrent
  game children. See [`subsystems/placement-and-wake.md`](../subsystems/placement-and-wake.md).
- **Session** — A single WebSocket connection from a player to a game,
  identified by a substrate-generated `sessionId`. Cluster-wide unique, opaque,
  stable for the connection lifetime. See [`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md).
- **AllowedPlayersList** — The per-game whitelist of `playerId`s the
  substrate will accept WS connections from. Mutated only by vercel backend
  admin calls.
- **History event** — A structured JSONL record of something the substrate
  observed. The complete history is the canonical observability stream.
  See [`reference/event-schema.md`](../reference/event-schema.md).
- **API kind registration** — A `(kindName, url)` row registered by the
  vercel backend telling the substrate where to dispatch a given
  `c.api.invoke` kind. See [`reference/admin-api.md`](../reference/admin-api.md).

## Identifiers

- **`gameId`** — Per-game id, vercel-backend-supplied at game create. Opaque
  string. Cluster-wide unique.
- **`playerId`** — Per-player id, vercel-backend-supplied in JWT subject.
  Opaque string.
- **`sessionId`** — Per-WS-connection id, substrate-generated. Opaque,
  unforgeable, cluster-wide unique, stable for the connection.
- **`runId`** — Per-scenario-runner-invocation id. Absent in production
  traffic. Lets oracles slice events from one run.
- **`traceId`** — W3C 16-byte hex. One placement → child → response round
  trip. See [`subsystems/observability.md`](../subsystems/observability.md).
- **`pax_seq`** — Monotonic u64 per shard, stamped on every history event.
  Causal ordering for oracles.
- **`shardId`** — Per-Fly-machine id. Substrate-assigned at shard registration.
- **`bundleName`** — Substrate-unique identifier of a bundle. Write-once,
  immutable-by-storage-policy.
- **`compatTag`** — Opaque string. Either `bundleCompatTag` (what a bundle
  writes) or `blobCompatTag` (what's currently stamped on the game's blob).
  Substrate enforces set membership only. See
  [`contract/bundle-compatibility.md`](../contract/bundle-compatibility.md).
- **`kindName`** — A registered API kind name like `ai.chat.v1`. Operator
  namespace; substrate looks up by literal string.

## Storage tiers

- **`c.state`** — Managed per-game state tier, ≤ 128 KB, whole-object
  read/write, CBOR-serializable, Tigris-canonical with a configurable flush
  window. See [`contract/storage.md`](../contract/storage.md).
- **`c.blob`** — Per-game keyed Tigris namespace at prefix
  `blob/<gameId>/`. ≤ 1024 keys, ≤ 100 MB total. Lazy reads via
  `c.blob.get(key)`. See [`contract/storage.md`](../contract/storage.md).
- **Tigris** — S3-compatible object storage. Canonical store for `c.state`,
  `c.blob`, bundle binaries, and history archives.
- **Active-game directory** — Redis (Upstash) row index mapping `gameId` to
  `shardId` and capacity push from each shard.
- **Per-shard volume** — Fly Volume per shard machine. Holds Rivet engine
  internals only (pegboard, workflow rows). Not in the `c.state` durability
  path.

## Trust positions

- **Platform-trusted** — Placement router, control plane, API gateway. If
  any of these is compromised, the substrate is compromised.
- **Shard-local-trusted** — Parent actor. If compromised, only that shard is.
- **Untrusted** — Child process running creator JS inside `isolated-vm`. No
  outbound network, no environment variables, CPU/memory capped.

See [`vision/trust-model.md`](trust-model.md).

## Channels and protocols

- **IPC channel** — A typed message kind exchanged between parent actor and
  child runner over the child_process IPC bridge. See
  [`reference/ipc-protocol.md`](../reference/ipc-protocol.md) for the
  envelope and channel reference,
  [`subsystems/parent-actor.md`](../subsystems/parent-actor.md) for the
  dispatcher.
- **WS sub-protocol** — The wire format between the vercel platform frontend
  wrapper and the parent actor. See
  [`reference/ws-subprotocol.md`](../reference/ws-subprotocol.md).
- **Placement API** — `POST /placement`; the only public non-WS endpoint
  outside `/admin/`. See [`reference/placement-api.md`](../reference/placement-api.md).
- **Gateway HTTP envelope** — The HTTP request shape the API gateway sends
  to URL services. See [`reference/gateway-envelope.md`](../reference/gateway-envelope.md).
- **Admin REST** — The HTTP surface the vercel backend uses to operate
  games, allowed players, bundles, shards, and API kinds. See
  [`reference/admin-api.md`](../reference/admin-api.md).

## Compute budgets

The eight per-game enforced budgets:

| Budget | What it caps |
|---|---|
| `cpu-ms-per-tick` | Per lifecycle/player handler invocation |
| `memory-bytes` | Steady-state child RSS |
| `bandwidth-bytes-per-sec` | Outbound WS bytes |
| `ws-messages-per-sec` | Outbound WS message rate |
| `state-bytes` | Total `c.state` size |
| `blob-bytes` | Sum of all `c.blob` key sizes |
| `blob-keys` | Distinct `c.blob` key count |
| `api-invocations-per-min` | Sliding 1-minute window on `c.api.invoke` |

See [`contract/compute-budgets.md`](../contract/compute-budgets.md).

## Lifecycle reasons

- **Wake reasons:** `cold-start`, `reconnect`, `cold-restart-after-crash`,
  `cold-restart-after-eviction`, `cold-restart-from-storage`, `upgrade`.
  See [`contract/lifecycle-and-wake.md`](../contract/lifecycle-and-wake.md).
- **Disconnect reasons:** `left`, `timedOut`, `removedFromAllowedPlayers`,
  `shardEvicted`, `gameDeleted`.
- **Sleep reasons:** `idle` (sleep-grace fired), `requestedBySleep` (bundle
  called `c.lifecycle.requestSleep`), `evicted` (capacity-pressure
  eviction), `shardEvicted` (shard is going away — drain or shutdown),
  `shutdown` (platform shutdown), `upgrade` (bundle pointer flipped while
  awake).

## Things deliberately undefined

The substrate has no vocabulary for these — by design:

- **Balance** / **Reservation** / **DebitLogEntry** / **Refund** — billing
  primitives, all in the vercel backend. See [`why/why-no-billing.md`](../why/why-no-billing.md).
- **User** — the substrate sees only `playerId` strings. Identity lives in
  the vercel backend.
- **Preset** — vercel backend mapping of `presetId → bundleName`.
- **Role** / **Participant** / **Spectator** — see
  [`operator-overlays/participation-and-roles.md`](../operator-overlays/participation-and-roles.md).
- **Tenant** / **Operator** — the substrate is single-consumer.
- **Schema** — compat tags are opaque strings; the substrate has no opinion
  on schema versioning beyond set membership.
