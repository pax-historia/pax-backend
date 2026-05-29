# Runner

> Layer: **Subsystem**

A Runner is a credential-less, network-less Node process that hosts
**many game isolates** (`isolated-vm`), one isolate per game, on a single
event loop. Each shard runs a small pool of Runners — on the order of the
core count — and the OS schedules them across cores. A Runner reaches
everything through an async `c.*` bridge to the Broker
([`broker.md`](broker.md)); it holds no credentials, opens no sockets, and
asserts no identity the Broker trusts. It is the bottom two rings of the
trust model: the process boundary (crash containment) and, inside it, the
per-game isolate boundary.

## Purpose

Execute untrusted creator JavaScript at high density with two layers of
isolation:

1. **The Runner process** — a real OS process boundary for crash
   containment, scheduled across cores by the OS.
2. **One `isolated-vm` isolate per game inside it** — separate V8 heaps,
   per-isolate memory cap, no host-object leakage, no visibility between
   co-tenant games.

The bundle inside an isolate sees only the `c.*` surface — no network, fs,
env, or process — exactly as before; only the transport behind `c.*`
changed.

## Owns

- The isolate lifecycle for each assigned game (create, eval bundle,
  dispose).
- The `c.*` shim inside each isolate that proxies calls over the bridge.
- Console proxying (`console.*` → `c.log.emit` with `source: 'console'`).
- The deterministic `c.rng()` / `c.now()` implementations when a test seed
  is set.
- Per-isolate CPU/memory counter sampling, reported to the Broker.
- The per-handler CPU timeout wrapping each handler invocation.

## Doesn't own

- Any credential, socket, or env var (it has none).
- Identity: `gameId` / `sessionId` / `connectedSessions` are stamped by
  the Broker, never asserted by the Runner.
- Sessions, budgets accounting, history writes, Tigris/Redis/gateway
  access — all Broker.
- Bundle fetch (the Broker delivers source; the Runner has no Tigris
  creds).
- Manifest validation as authority (done at upload + cross-checked by the
  Broker).

## Density and packing

Many isolates share one Runner's event loop cooperatively. Profiles drive
packing: bursty / memory-heavy storytelling games pack densely on shared
Runners (idle most of the time, so they rarely collide); sustained-CPU
physics / high-tick games get their own Runner or few co-tenants so they
effectively own a core's worth of time. We deliberately use **separate
single-threaded processes, not worker threads** — it reuses the existing
fork + IPC model, gives a real process boundary for crash containment, and
lets the OS do all core scheduling.

`K` (isolates per Runner) is a dial: higher density vs larger native-crash
blast radius vs more intra-Runner CPU contention. Runner count is a dial
too: more Runners = smaller native-crash blast radius, but more ~36 MB
process baselines and more channels. (Measured unit costs, Node 22 /
isolated-vm 5.0.4: process ~36 MB, worker thread ~6.6 MB, bare isolate
~1.0 MB; a loaded `historia-default` isolate ~1.1 MB. Collapsing
per-game Node duplication is roughly a 7-10× density win for typical
games.)

## Wake and sleep

- **Wake = create an isolate + eval the bundle.** No `fork()`, no Node
  boot, no workflow hydrate — materially faster cold start than a per-game
  process. The Broker delivers the bundle source (it has the Tigris
  creds); the Runner compiles it inside the isolate.
- **Sleep = dispose the isolate.** The Broker checkpoints durable state
  before releasing the game; the Runner just tears down the isolate and
  frees its slot.

## The async `c.*` bridge

The one real behavioral change from a per-game process model: the bridge
is **non-blocking**. A blocking bridge is fine at one game per process but
fatal at many, because one game's pending `c.api.invoke` would freeze its
co-tenants. Two boundaries:

- **Isolate → Runner (in-process):** use `isolated-vm`'s promise-returning
  `apply`, so a waiting isolate yields the event loop and co-tenants run.
  The isolate's code still reads as `await c.state.read()`.

  ```js
  // blocking (one game per process): freezes the whole event loop
  const responseJson = __pax_c_state_read.applySyncPromise(undefined, []);
  // async (many isolates): returns a real promise; the isolate yields
  const responseJson = await __pax_c_state_read.apply(undefined, [], { result: { promise: true } });
  ```

- **Runner → Broker (cross-process):** requestId-based async message
  passing — many requests in flight, nothing blocks.

What does **not** change: the per-handler CPU timeout still wraps each
handler (it can interrupt a tight loop), and there is no new concurrency
hazard inside a game (one isolate still awaits sequentially; isolates
share no state).

## Two runners

The substrate ships two Runner implementations for the same contract:

| Runner | Isolation | Default? | Purpose |
|---|---|---|---|
| ivm Runner | `isolated-vm` isolate per game | Yes | Production |
| no-ivm Runner | No isolate boundary (JS context per game) | No | Conformance / contract-drift detector |

Both implement the same `c.*` surface and the same Broker bridge. The
no-ivm Runner lets CI run the full scenario suite against both, catching
contract drift between the inner runtime and the substrate's expectations.
It has weaker security (no isolate boundary) and is **not** for production.

## The `c.*` shim

Inside the isolate, `c.*` is a frozen object whose methods are
substrate-provided. Each method serializes its arguments, posts a request
over the bridge, awaits the response, and returns it.

```ts
// Inside the isolate (schematic; actual impl uses isolated-vm transfer mechanisms)
const c = Object.freeze({
  state: {
    read:  () => bridge({ channel: 'state.read' }),
    write: (value) => bridge({ channel: 'state.write', payload: { value } }),
    flush: () => bridge({ channel: 'state.flush' }),
  },
  blob: {
    put: (key, bytes) => bridge({ channel: 'blob.put', payload: { key, bytes } }),
    get: (key) => bridge({ channel: 'blob.get', payload: { key } }),
    delete: (key) => bridge({ channel: 'blob.delete', payload: { key } }),
    list: (prefix) => bridge({ channel: 'blob.list', payload: { prefix } }),
  },
  ws: {
    send: (target, body) => {
      try { JSON.stringify(body); } catch {
        return { ok: false, error: 'serializationFailed' };
      }
      return bridge({ channel: 'ws.send', payload: { target, body } });
    }
  },
  // ... rng/now (deterministic in test mode), log, metrics, players, compute, api, lifecycle
});
```

The substrate's in-isolate code is small (~200 lines) and audited. The
isolate exposes nothing else — no `process`, `fs`, `net`, or `global`
beyond the JS standard library.

## Determinism

When a test seed is set in the Broker's environment, the Broker passes a
per-game derived seed (`hash(testSeed + gameId + bundleName +
bundleCompatTag)`) to the Runner at isolate creation. The isolate uses it
for `c.rng()` (a seeded PRNG) and `c.now()` (`nowStartMs + monotonic
counter * tickMs`). In production, `c.rng()` uses `crypto.randomBytes` and
`c.now()` returns `Date.now()`.

## CPU enforcement

Each handler invocation is wrapped with a `handlerTimeoutMs` bound; on
timeout the handler is aborted and the Runner emits a handler-timeout
event. A timeout does **not** kill the isolate or the Runner — the next
handler runs normally.

```ts
async function invokeHandler(handlerName, payload) {
  const start = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), handlerTimeoutMs);
  try {
    await bundle[handlerName](c, payload);
    emit({ channel: 'handler.complete', payload: { handlerName, durationMs: performance.now() - start } });
  } catch (e) {
    const durationMs = performance.now() - start;
    emit({ channel: 'handler.error', payload: ac.signal.aborted
      ? { handlerName, code: 'handlerTimeout', durationMs, timeoutMs: handlerTimeoutMs }
      : { handlerName, code: 'handlerException', durationMs, message: String(e) } });
  } finally { clearTimeout(timer); }
}
```

## Memory enforcement

`isolated-vm` enforces a per-isolate cap (`memoryLimit`, fixed at isolate
creation). If a game exceeds its cap, V8 throws `RangeError`; the handler
errors, the isolate becomes unusable, the Runner disposes it and reports
the cap hit, and the Broker re-wakes the game (`cold-restart-after-crash`,
`errorClass: 'oom'`) — **without disturbing co-tenant isolates**. The cap
is generous by preset; admission counts the player-scaled reservation, not
the cap (see [`broker.md`](broker.md) §Resource model). For the no-ivm
Runner, `--max-old-space-size` plays the analogous role but at process
granularity.

## Failure model

| Failure | Recovery |
|---|---|
| Bundle source fails to parse | Emit `bundle.loaded.failed`; the isolate doesn't start; the Broker gives up on this game (upload validation should have caught it) |
| Handler throws | Emit `handler.error`; isolate stays alive |
| Handler times out | Emit `handler.error` `code: handlerTimeout`; isolate stays alive |
| Isolate OOM (cap hit) | Dispose the one isolate; report to Broker; re-wake `cold-restart-after-crash`; **co-tenants unaffected** |
| `onWake` throws | Emit `onWake.failed`; counts toward the rollback threshold (guarantee #13) |
| **Native V8 crash / segfault in a Runner** | Kills the Runner process = its co-tenant games (bounded by `K`); the Broker re-places them. This is the blast-radius cost of packing (see Crash blast radius) |

## Crash blast radius

- JS-level misbehavior (handler throw/timeout, per-isolate OOM) is
  contained to one game in every configuration — identical to before.
- A **native V8 crash** kills one Runner process and its co-tenant games.
  Bounded by `K`. Guarantee #8 (blast radius = 1 game) holds exactly at
  `K = 1`; packing `K > 1` weakens native-crash blast radius to `K` — a
  per-preset dial, with crash-sensitive presets kept thin. See
  [`vision/guarantees.md`](../vision/guarantees.md) #8.

## Trust position

**Untrusted-to-semi-trusted, credential-less.** A native escape inside a
Runner reaches only the low-value content of that Runner's co-tenant
games; it obtains no credential, cannot spend money, cannot impersonate a
player to a URL service (the Broker stamps identity), and cannot reach
other Runners or shards. The credential-less invariant is what makes this
residual risk acceptable. Inside the Runner, each isolate is untrusted and
cannot see siblings. See [`vision/trust-model.md`](../vision/trust-model.md)
and [`why/why-isolated-vm.md`](../why/why-isolated-vm.md).

## Observability surface

| Signal | Notes |
|---|---|
| Per-isolate CPU/memory: `isolate.cpuTime` / `isolate.wallTime` (cumulative bigint) + `getHeapStatistics()`, sampled per Runner on a 1-10 s tick and delta'd | Reported to the Broker; raw per-game numbers go to history/logs/traces, never as metric labels |
| Logs: isolate output flows over the bridge to the Broker | Broker records |
| Process truth: `process.cpuUsage()` + RSS per Runner | Reconciles per-isolate sums |
| History events: `handler.complete`, `handler.error`, isolate lifecycle, `console.*` proxies, bundle `log.emit` | Emitted via bridge; Broker writes |

Per-game observability is a **built-in counter sample**, not hot-path
tracing — one Runner reading its `K` isolates in-process is cheaper than
the old one-`/metrics`-endpoint-per-game model. The same readings feed
admission, player-scaled reservation, watermark triggers, and eviction
selection: observability and control are the same cheap signal.

## End-state contract

- **Wake (create isolate + eval) completes within `bundleEvalTimeoutMs`**
  (typically 5 s); slower bundles are uploadable but cold-start slowly.
- **Bridge round trip isolate→Runner→Broker→Runner→isolate ≤ 2 ms p99**
  for non-blocking calls.
- **Each isolate is fully isolated** — no shared global state, no host
  objects leaking in, no visibility between co-tenants.
- **A waiting isolate yields the event loop** — one game's pending call
  never freezes a co-tenant.
- **Determinism is reproducible** across runs with the same
  `(testSeed, gameId, bundleName, bundleCompatTag)`.

## Cross-references

- [`why/why-isolated-vm.md`](../why/why-isolated-vm.md)
- [`why/why-broker-runner.md`](../why/why-broker-runner.md)
- [`vision/trust-model.md`](../vision/trust-model.md)
- [`broker.md`](broker.md) — supervisor, credential holder, bridge peer
- [`reference/ipc-protocol.md`](../reference/ipc-protocol.md) — the bridge wire contract
- [`contract/creator-runtime.md`](../contract/creator-runtime.md) — the `c.*` surface
- [`contract/compute-budgets.md`](../contract/compute-budgets.md)
- [`vision/guarantees.md`](../vision/guarantees.md) #8
