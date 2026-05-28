# `orchestration/url-services/`

First-party reference URL services that the API gateway dispatches to. They
implement the library-defined HTTP envelope from [plan](../../README.md)
§"The HTTP wire protocol". For v1 they're HTTP routes inside the gateway
process; tomorrow any of them can move to their own Fly app, region, or
runtime without touching the gateway.

## Contents

| Service | Purpose |
|---|---|
| `echo/` | No-op. Returns `args` verbatim. The simplest gateway round-trip. |
| `delay/` | Controllable latency. Tests timeout and `providerError` paths. |
| `http.fetch/` | Real outbound HTTP against an allowlist. The "do something real" reference. |
| `mock-ai.v1/` | Canned responses keyed by `args` hash. **No billing logic.** A deterministic ai-shaped responder for the hello-world bundles and the scenario-runner. |
| `billing-mock.v1/` | *Reference only.* Demonstrates how an operator could implement balance / credit / refund / spectator policy on top of session observability + the URL-service pattern. **Not part of the substrate's contract** — operators are free to ignore it. |

Real production AI / vendor integrations are **operator-owned URL services
outside this repo**. See [plan](../../README.md) §"Why no billing primitives".

Stub.
