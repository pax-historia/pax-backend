# Child runner sandbox

> Layer: **Subsystem**

The child runner is the OS-level process that hosts a single game's bundle
inside an `isolated-vm` isolate. One child per game; supervised by the
parent actor; isolated from the network, the filesystem, and the
environment.

## Purpose

Execute untrusted creator JavaScript with three nested layers of
isolation:

1. **OS process** (`node child_process`) — provides per-game memory cap,
   CPU isolation via cgroup, process-level crash blast radius.
2. **`isolated-vm` isolate** — provides per-isolate memory accounting,
   syntactic isolation from the Node process internals, no host-object
   leakage.
3. **Substrate constraints inside the child** — no network sockets, no
   environment variables, no filesystem access, all `c.*` calls
   proxied via IPC.

## Owns

- The bundle's JavaScript execution.
- The isolate lifecycle (boot, eval, dispose).
- The `c.*` shim that proxies calls into IPC envelopes.
- Console proxying (`console.*` → `c.log.emit` with `source: 'console'`).
- The deterministic `c.rng()` and `c.now()` implementations when
  `PAX_TEST_SEED` is set.
- Local lint enforcement (rejecting bundles that use raw `Math.random`
  / `Date.now`) — primarily an SDK-side concern, but the child can
  detect and emit `bundle.eval.lintFailed` if a bundle slips through.

## Doesn't own

- The bundle's history events (the parent writes those; the child only
  emits IPC).
- Anything outside the isolate (compute budgets, sessions, Tigris).
- Manifest validation (done at bundle upload + boot).
- Bundle fetch (parent gives the source via the `bootstrap` IPC message).

## Two runners

The substrate ships two child runners for the same contract:

| Runner | Path | Default? | Purpose |
|---|---|---|---|
| `runtime/child-runner-ivm/` | Inside `node child_process` + `isolated-vm` isolate | Yes | Production runner |
| `runtime/child-runner-noivm/` | Inside `node child_process` only (no isolate) | No | Conformance test runner |

Both implement the same IPC envelope and the same `c.*` surface. The
no-ivm runner exists so the CI release gate can run the full scenario
suite against both, catching contract drift between the inner runtime
and the substrate's expectations.

The no-ivm runner has weaker security guarantees (no isolate boundary
between bundle and Node) and is **not** for production. It's a
contract-drift detector.

## Boot sequence

```
1. Parent forks: node child-runner-{ivm|noivm}/dist/child.mjs
2. Child starts; sends `ready` IPC message.
3. Parent sends `bootstrap`:
   {
     gameId, runId?, bundleName, bundleCompatTag,
     bundleSource: "..." (the bundle's compiled JS),
     handlerTimeoutMs, computeBudgetSnapshot, testSeed?, ...
   }
4. Child boots the isolate (ivm) or sets up the JS context (noivm).
5. Child loads the bundle source via Function() / isolate.compile().
6. Child captures the manifest via the bundle's defineBundle() call.
7. Child validates manifest fields (matches what parent supplied).
8. Child sends `bundle.loaded` IPC + emits success log.
9. Parent sends `onWake` with full payload.
10. Child invokes the bundle's onWake handler inside the isolate, wrapped
    in a handlerTimeoutMs-bound timeout.
11. On handler return / timeout / error: emit child.handlerComplete or
    child.handlerError with durationMs.
```

## The `c.*` shim

Inside the isolate, `c.*` is a frozen object whose methods are
substrate-provided. Each method serializes its arguments, posts an IPC
envelope to the parent, awaits the response, and returns it to the
bundle.

```ts
// Inside the isolate (schematic; actual impl uses isolated-vm transfer mechanisms)
const c = Object.freeze({
  state: {
    read:  () => ipcRequest({ channel: 'state.read' }),
    write: (value) => ipcRequest({ channel: 'state.write', payload: { value } }),
    flush: () => ipcRequest({ channel: 'state.flush' }),
  },
  blob: {
    put: (key, bytes) => ipcRequest({ channel: 'blob.put', payload: { key, bytes } }),
    get: (key) => ipcRequest({ channel: 'blob.get', payload: { key } }),
    delete: (key) => ipcRequest({ channel: 'blob.delete', payload: { key } }),
    list: (prefix) => ipcRequest({ channel: 'blob.list', payload: { prefix } }),
  },
  ws: {
    send: (target, body) => {
      // pre-IPC: serialize + check JSON-safety
      try { JSON.stringify(body); } catch {
        return { ok: false, error: 'serializationFailed' };
      }
      return ipcRequest({ channel: 'ws.send', payload: { target, body } });
    }
  },
  // ... rng/now (deterministic in test mode), log, metrics, players, compute, api, lifecycle
});
```

The substrate's child-side code is small (~200 lines) and audited. The
isolate exposes nothing else — no `process`, no `fs`, no `net`, no
`global` (except the JS standard library).

## Determinism

When `PAX_TEST_SEED` is set in the parent's environment, the parent
passes a per-game derived seed (`hash(testSeed + gameId + bundleName +
bundleCompatTag)`) to the child in `bootstrap`. The child uses that seed
for `c.rng()` and `c.now()`.

- `c.rng()` is a deterministic PRNG seeded from the derived seed.
- `c.now()` returns `nowStartMs + monotonic counter * tickMs` — also
  deterministic.

In production, `c.rng()` uses `crypto.randomBytes` (cryptographic
quality) and `c.now()` returns `Date.now()`.

## CPU enforcement

The parent supplies `handlerTimeoutMs` in `bootstrap`. The child wraps
every handler invocation:

```ts
async function invokeHandler(handlerName, payload) {
  const start = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), handlerTimeoutMs);
  try {
    await bundle[handlerName](c, payload);  // signal via ac if cooperative
    const durationMs = performance.now() - start;
    emitIpc({ channel: 'child.handlerComplete', payload: { handlerName, durationMs } });
  } catch (e) {
    const durationMs = performance.now() - start;
    if (ac.signal.aborted) {
      emitIpc({ channel: 'child.handlerError', payload: { handlerName, code: 'handlerTimeout', durationMs, timeoutMs: handlerTimeoutMs } });
    } else {
      emitIpc({ channel: 'child.handlerError', payload: { handlerName, code: 'handlerException', durationMs, message: String(e) } });
    }
  } finally {
    clearTimeout(timer);
  }
}
```

A handler timeout does **not** kill the child. The next handler invocation
runs normally.

## Memory enforcement

`isolated-vm` enforces a per-isolate memory cap (`new
ivm.Isolate({ memoryLimit: budgetMb })`). If the isolate exceeds the
cap, V8 throws `RangeError`; the handler errors and the isolate becomes
unusable. The child detects this, emits `child.fatal`, exits, and the
parent restarts the child (next wake: `cold-restart-after-crash`,
`errorClass: 'oom'`).

For the no-ivm runner, the Node child's `--max-old-space-size` flag is
set to the same budget. OOM kills the process; same recovery path.

## Bundle source delivery

The parent fetches the bundle binary from Tigris (cached locally on the
shard) and sends the source via the `bootstrap` IPC message. The child
never reads from Tigris directly (it has no S3 credentials and no
filesystem access).

Source is delivered as a string. The child compiles it inside the
isolate via `isolate.compileScript()` (ivm) or `new Function()`
(no-ivm), then runs it to extract the bundle's exports.

## Failure model

| Failure | Recovery |
|---|---|
| Bundle source fails to parse | Emit `bundle.loaded.failed`; child exits; parent gives up on this game (manifest validation should have caught) |
| Bundle handler throws | Emit `child.handlerError`; child stays alive |
| Bundle handler times out | Emit `child.handlerError` with `code: 'handlerTimeout'`; child stays alive |
| Isolate OOM | Emit `child.fatal`; child exits; parent restarts with `cold-restart-after-crash` |
| Child process OOM | Parent detects via SIGKILL; restart with `cold-restart-after-crash` |
| Child segfault | Same |
| Bundle's `onWake` throws | Emit `onWake.failed`; counts toward rollback threshold (guarantee #13) |

Guarantee #8 (crash blast radius = 1 game) holds because each child is a
separate OS process; one game's child dying doesn't touch any other.

## Trust position

**Untrusted.** See [`vision/trust-model.md`](../vision/trust-model.md).

## Observability surface

| Signal | Notes |
|---|---|
| Logs: child emits `log.emit` IPC; parent records | All child output flows through the parent |
| Metrics: child doesn't expose `/metrics`; parent's `pax_parent_compute_budget_consumed_ratio` reflects child usage | Parent-side |
| Traces: child emits `child.handler.*` spans inside its IPC envelopes; parent stitches into its own span tree | Parent-side |
| History events: `child.handlerComplete`, `child.handlerError`, `child.fatal`, `child.exit`, `child.restart`, `console.log` proxies, bundle's own `log.emit` calls | Parent writes; child emits via IPC |

## End-state contract

- **Bundle eval completes within `bundleEvalTimeoutMs`** (typically 5
  seconds). Bundles that take longer to load are uploadable but won't
  cold-start in production-acceptable time.
- **IPC envelope round trip child→parent→child ≤ 2 ms p99** for non-blocking calls.
- **The isolate is fully isolated** — no global state shared with other
  isolates, no host objects leaking in.
- **`PAX_TEST_SEED` determinism is reproducible across runs** with the
  same `(testSeed, gameId, bundleName, bundleCompatTag)`.

## Cross-references

- [`why/why-isolated-vm-in-child.md`](../why/why-isolated-vm-in-child.md)
- [`vision/trust-model.md`](../vision/trust-model.md)
- [`parent-actor.md`](parent-actor.md) — supervisor and IPC peer
- [`contract/creator-runtime.md`](../contract/creator-runtime.md) — the
  `c.*` surface the shim implements
- [`contract/compute-budgets.md`](../contract/compute-budgets.md)
- [`vision/guarantees.md`](../vision/guarantees.md) #8
