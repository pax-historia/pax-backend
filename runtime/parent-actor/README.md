# `runtime/parent-actor/`

The platform-trusted RivetKit actor that owns one game. **The parent is a
dumb pipe; the child is the game** (see [plan](../../README.md)
§"Architectural philosophy"). Responsible for:

- WS lifecycle, session id generation, allowed-players gate (guarantees #2, #3)
- Test-mode seed pinning: `PAX_TEST_SEED` drives shard-namespaced run/session
  id generation and is forwarded unchanged to child bootstrap for deterministic
  `c.rng()` / `c.now()`
- Compute-plane quota enforcement (guarantee #7)
- IPC broker between child and the rest of the cluster
- Storage tier dispatch (`c.state` whole-object reads/writes against an
  in-process cache, throttled async flush to Tigris; `c.blob` keyed
  namespace at the Tigris prefix `blob/<gameId>/` with substrate-enforced
  per-game caps for both byte count and key count). Tigris is canonical
  for both tiers; the shard's RocksDB is not in the `c.state` durability
  path (see [README](../../README.md) §"Storage tiers" + guarantee #11).
- Drain-flush handshake: on `POST /admin/shards/:id/drain`, the parent-actor
  flushes every running game's pending `c.state` write to Tigris before
  ACKing the drain — zero `c.state` loss on planned shard moves.
- `onWake` hydration from Tigris and `onSleep` dispatch with a minimum
  flush budget
- Child crash recovery: unexpected exits record `child.exit`, emit
  `child.restart`, and wake the same game with `cold-restart-after-crash`
- Migration rollback safety: repeated `onWake` failures on a newly flipped
  bundle restore the previous bundle pointer while the rollback backup is live
- Forwarding `c.api.invoke` calls to the API gateway with the context envelope
- Writing every channel call / lifecycle event / session transition / api
  round trip to the history, including `api.invoke.wire` raw payload records
  from the gateway (guarantee #14)
- Exposing `GET /health` and `GET /metrics` on `PAX_PARENT_METRICS_BIND`
  (default `127.0.0.1:7700`) for parent-process gauges and history counters

Current source passes implement the local actor loop used by the smoke path.
