# Why: a Broker plus a pool of credential-less Runners

> Layer: **Why**

## Considered

How to run many games per shard while keeping creator JS unable to touch
credentials or other games:

1. **Per-actor workflow engine (Rivet).** Each game is a Rivet actor
  backed by a per-actor RocksDB workflow; the engine owns placement,
   supervision, and a guard/tunnel for WS routing. This was the v1
   starting point.
2. **One Node process per game.** A per-shard supervisor `fork()`s one
  whole Node child process per game, each hosting one isolate.
3. **One trusted Broker + a small pool of credential-less Runner**
  **processes**. The Broker holds every credential and all identity  
   authority; each Runner is a single-threaded Node process hosting many  
   game isolates and holding nothing. A game is a Broker record + an  
   isolate in a Runner, with durable state in Tigris.

We chose option 3.

## Why we said no to options 1 and 2

### Why not the per-actor workflow engine (option 1)

- **It was the measured ceiling.** The Phase 5 soak at 1000 games / 10
shards crashed in the workflow worker with multi-second RocksDB commits
and "took too long pulling workflows." The choke is durable-disk +
per-actor workflow bookkeeping on the hot path: I/O- and lock-bound,
only hundreds/sec, with the box idle while users time out. The same
centralized/disk-bound write head we diagnosed elsewhere.
- **We use ~20% of it and disable the rest.** The substrate owns its own
budgets, `c.api.invoke` dispatch, history, bundle compatibility, and
`sessionId` generation; the engine's value was actor placement + WS
tunnel + per-actor supervision — all replaceable with simpler pieces.
- **Durability belongs in Tigris, not per-shard RocksDB.** State is
Tigris-canonical (`[why-tigris-canonical.md](why-tigris-canonical.md)`);
a per-actor durable-disk engine duplicates the durability story on the
hot path and reintroduces shard-pinned state.

We therefore drop the per-actor workflow engine, the pegboard scheduler,
per-actor RocksDB persistence, and the guard/tunnel WS routing. WS
transport becomes a mature library in the Broker plus Fly-proxy machine
routing; a game's liveness becomes an in-memory Broker record plus the
Redis directory.

### Why not one Node process per game (option 2)

- **It duplicates the Node runtime per game.** Measured on this repo
(Node 22, isolated-vm 5.0.4): a separate process is ~36 MB, a worker
thread ~6.6 MB, a bare isolate ~1.0 MB; a loaded `historia-default`
isolate is ~1.1 MB. Real games average ~1.3 MB live heap. So ~97% of a
typical game's footprint is duplicated Node runtime. Collapsing it is a
~7-10× density win for typical games (and ~2× for the rare giant, which
is dominated by its own state).
- **Cold start pays a full Node boot per wake.** Per-game process means
every wake forks a process and boots Node before it can eval the bundle.

## Why a Broker + Runner pool (option 3)

- **Density without losing isolation.** Many isolates share a Runner's
event loop (separate V8 heaps, per-isolate caps), so the per-game cost
collapses to roughly the isolate weight. The OS schedules the small pool
of Runner processes across cores.
- **A clean credential boundary.** All credentials, identity authority, WS
termination, budgets, the state cache + checkpoint, and gateway/Redis
egress live in the one trusted Broker; the Runners hold nothing. The
worst case — a native escape inside a Runner — reaches only the
low-value content of its co-tenant games, never a credential. That
invariant is load-bearing.
- **Reuses what already worked.** The fork + requestId IPC model and the
`c.`* shim carry over almost unchanged; the one real change is making
the bridge async (promise-returning `apply` in-process; requestId IPC
cross-process) so a waiting isolate yields instead of freezing its
co-tenants.
- **Cheap wake.** Wake = create an isolate + eval the bundle (no `fork()`,
no Node boot, no workflow hydrate); sleep = dispose the isolate +
checkpoint.

### Separate processes, not worker threads

We use separate single-threaded Runner processes rather than
`worker_threads`: a real process boundary for native-crash containment,
reuse of the existing fork + IPC model, and OS-level core scheduling.
`SharedArrayBuffer` is irrelevant across process boundaries; large-blob
transfer copies through the channel (with a tmpfs path handoff only if
measured). The cost is a weakened crash blast radius — a native crash
takes a Runner's `K` co-tenants, a per-preset dial (see
`[vision/guarantees.md](../vision/guarantees.md)` #8).

## What would change our mind

- **Game resource usage turns out correlated.** The whole oversubscribe-
and-measure model assumes usage is stable and largely uncorrelated. A
coordinated spike (a scheduled in-game event, or a game type sustained
by nature) is the failure case; headroom + advisory hints + thinner
packing are the cushion. If correlation shows up at scale, revisit
before adding machinery.
- **A single Broker event loop saturates a core** at a shard's message
rate — then shard the Broker (split games across two event loops),
measured against `event_loop_lag`, before anything more exotic.
- **Native escapes prove frequent enough** that `K > 1` blast radius is
unacceptable for the main workload — then drive `K` toward 1 for those
presets, trading density for containment.

## See also

- `[subsystems/broker.md](../subsystems/broker.md)` — the trusted, per-shard process
- `[subsystems/runner.md](../subsystems/runner.md)` — the credential-less isolate host
- `[why-isolated-vm.md](why-isolated-vm.md)` — why isolates, and why many per Runner
- `[why-tigris-canonical.md](why-tigris-canonical.md)` — why durability isn't on the shard
- `[vision/trust-model.md](../vision/trust-model.md)` — the three rings
- `[vision/guarantees.md](../vision/guarantees.md)` #8

