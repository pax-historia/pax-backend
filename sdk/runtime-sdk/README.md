# `sdk/runtime-sdk/` — `@pax-backend/runtime-sdk`

The typed contract surface creators import. Treat the SDK as the contract:
every guarantee in [plan](../../README.md) §"Strong platform guarantees" maps
to either an SDK type, a lifecycle hook signature, or a `c.*` call.

Includes the `BundleManifest` type and a local pre-publish validator that
mirrors the admin endpoint's upload-time check
(`compatTagProduced ∈ compatTagsAccepted`).

Current source pass exposes the typed creator surface for lifecycle hooks
including `onHostEvent`, websocket send with typed quota/serialization
responses, logs, metrics, URL-service calls, players, compute budgets,
state/blob storage, and deterministic `c.rng()` / `c.now()` helpers.

Storage surface, per [plan](../../README.md) §"Storage tiers":

- **`c.state`** is the managed per-game state tier: whole-object
  `read()` / `write(value)` / `flush()` against an in-process cache that
  is asynchronously persisted to Tigris (canonical). 128 KB cap.
- **`c.blob`** is the keyed per-game namespace:
  `put(key, bytes)` / `get(key)` / `delete(key)` / `list(prefix?)`.
  Async, durable on resolve. ≤ 1024 keys and ≤ 100 MB per game.

The child IPC carries blob bytes as base64 internally because Node IPC uses
JSON serialization; bundle authors see `Uint8Array`.
