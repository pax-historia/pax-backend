# Non-goals

> Layer: **Vision**

This is the closed list of things the substrate **deliberately does not do**,
with a pointer to the corresponding `why/` doc that explains the rejection.

If something here ever gets re-litigated, the conversation should happen in
the corresponding `why/` doc (or, for new rejections, a new `why/` doc), not
by adding a new feature to the contract.

## Business-plane resources

- **Billing.** No balances, no debits, no reservations, no refunds, no
  pricing math. See [`why/why-no-billing.md`](../why/why-no-billing.md).
- **Identity.** No user table. The substrate sees opaque `playerId` strings
  in JWTs and the allowed-players list. Identity belongs to the vercel
  backend.
- **Roles / participation / spectator.** Not substrate primitives.
  Participation lives in a URL service (see
  [`operator-overlays/participation-and-roles.md`](../operator-overlays/participation-and-roles.md)
  and [`why/why-no-role-units.md`](../why/why-no-role-units.md)).
- **Moderation policy.** Substrate enforces force-disconnect on
  allowed-players removal; everything else is a URL service kind. See
  [`operator-overlays/moderation-policy.md`](../operator-overlays/moderation-policy.md).
- **Game metadata.** No titles, descriptions, preview images, tags, ratings,
  comments. All in the vercel backend.
- **Preset table.** No `presetId → bundleName` mapping. The substrate sees
  only `bundleName`.
- **Marketplace / discovery / search / recommendations.** Not substrate
  concerns.
- **Revenue share / accounting / financial reporting.** Not substrate
  concerns.

## Lifecycle and scheduling

- **Async games (server-driven progression while no one is connected).**
  Games are alive iff someone is connected (plus the sleep-grace window and
  host-driven wakes). See
  [`why/why-no-async-games.md`](../why/why-no-async-games.md).
- **Scheduled wakeups (`c.schedule.*`, `onTimer`).** A bundle cannot
  schedule its own future wake. See
  [`why/why-no-scheduled-wakeups.md`](../why/why-no-scheduled-wakeups.md).
- **Background loops the creator can't account for.** No `run()`, no
  per-tick callbacks, no engine-driven simulations. The bundle executes
  only inside its lifecycle hooks.
- **Server-side cron** in the substrate. If the vercel backend wants
  cron-shaped behavior (e.g. force-end stale games), it runs its own cron
  and calls admin endpoints.

## Versioning and audience

- **Per-channel payload version fields (`v:`).** Channel payloads are
  governed entirely by the bundle's `runtimeContractRequired`; no in-band
  version fields. See
  [`contract/bundle-compatibility.md`](../contract/bundle-compatibility.md).
- **Audience / channel / cohort tags as substrate primitives.** Beta and
  canary channels compose from per-game bundle pinning plus the contract
  placement gate. See
  [`why/why-no-audience-axis.md`](../why/why-no-audience-axis.md).

## Storage and persistence

- **In-app Postgres.** The substrate has no ledger to back. URL services
  bring their own storage.
- **Keyed granularity forced on authors.** The default is one byte-level
  state object the substrate versions; keyed `c.blob` is a deferred,
  optional escape hatch, not the default surface. See
  [`why/why-one-state-object.md`](../why/why-one-state-object.md).
- **Per-key blob versioning at the substrate level.** A single
  `blobCompatTag` per game (state object + optional blob namespace).
  Per-key versioning inside the namespace is the bundle's problem.
- **Whole-namespace blob snapshots in `onWake`.** When a game uses the
  keyed tier, the bundle reads what it needs lazily via `c.blob.get(key)`.
  See [`why/why-one-state-object.md`](../why/why-one-state-object.md).
- **Bundle-facing multi-key transactions.** Atomicity is the substrate's
  internal root-swap at checkpoint, not a transaction API. See
  [`why/why-unified-durability.md`](../why/why-unified-durability.md).

## Transport

- **WebSocket data path through the placement router.** The router is
  HTTP-only. Clients connect WS directly to the Broker on the shard (the
  Fly proxy pins the connection there).
- **Channel-style WS subscriptions.** The substrate exposes
  `c.ws.send(target, body)` only (fanned out Broker-side). Bundles route
  topics inside their own WS handler.
- **Cross-game RPC.** There is no substrate primitive for one game to call
  another. Cross-game work goes through URL services or admin calls.

## API channel

- **Substrate-interpreted `args` or `result`.** The substrate doesn't parse
  what's inside the request body beyond the envelope. See
  [`why/why-url-per-kind.md`](../why/why-url-per-kind.md).
- **Streaming / SSE responses.** The gateway is request/response only.
  Streaming-shaped behavior lives inside a URL service or as multiple
  invokes.
- **Vendor SDK opinions.** The substrate doesn't know what Anthropic,
  OpenAI, or any other vendor are. URL services bring their own SDKs.
- **API kind deprecation timing.** The vercel backend unregisters a kind
  when it's done; subsequent calls fail `kindUnknown`. The substrate has
  no expiry timer.

## Membership

- **Open-with-blocklist mode** or per-game blocklists. The substrate's
  membership model is per-game whitelist only.
- **Global block list.** Cross-game blocking is host iteration over
  `removeAllowedPlayer`.
- **Membership-change events to the creator.** The creator learns about
  players through `onPlayerConnect` / `onPlayerDisconnect` only. There is
  no `onAllowedPlayerAdded` hook.

## Observability

- **Push subscriptions / webhooks** to the vercel backend. The vercel
  backend tails `GET /admin/history` or polls. We add push if polling cost
  hurts.
- **Client-side observability.** The substrate's story ends at WS send.
  Frontend telemetry is the vercel platform frontend wrapper's problem.
- **Analytics endpoints** (count games by tag, top creators, etc.). The
  vercel backend queries history if it cares.

## Multi-tenancy

- **Per-tenant config table.** The substrate is single-consumer.
- **Per-tenant rate limits, namespaces, isolation.** Same.

## Frontend

- **Frontend.** The substrate has none.
- **Client bundles, client-bundle versioning, iframe authentication, default
  client.** None.
- **Pixels.** The substrate emits zero pixels.

## Substrate ergonomics

- **Multi-game atomic operations** beyond `DELETE /admin/players/:playerId`.
  Bulk operations are host iteration.
- **`forceDisconnect` separate from `removeAllowedPlayer`.** Force-disconnect
  is a consequence of roster mutation, not a standalone admin verb.
- **Substrate-level metadata endpoints.** No game-titles endpoint, no
  preset-list endpoint.

## Sandboxing depth

- **Defence against a Node/V8 zero-day inside a Runner.** The substrate's
  security floor is "escape-the-isolate leaves the creator in a
  credential-less, network-less Runner; escape-the-Runner requires a
  Node/V8 zero-day, which we accept." See
  [`why/why-isolated-vm.md`](../why/why-isolated-vm.md).

## Things sometimes confused with non-goals (these ARE goals)

For clarity, the following ARE substrate responsibilities even though they
sometimes feel like business-plane:

- **Compute-plane budget enforcement** (8 budgets). The substrate enforces
  because only the runtime can measure.
- **`sessionId` uniqueness and stability.** Substrate primitive.
- **Host-event durability** (`wakeOnDelivery: true`). Substrate primitive,
  not a vercel-backend pattern. See [`vision/guarantees.md`](guarantees.md)
  guarantee #17.
- **Bundle storage** (binary + manifest in Tigris). Substrate-owned.
- **Wire-grain record/replay.** Substrate-owned; URL services don't know
  about it.
