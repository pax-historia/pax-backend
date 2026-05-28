# `orchestration/url-services/`

First-party reference URL services that the API gateway dispatches to.
They implement the library-defined HTTP envelope from
[plan](../../README.md) §"The HTTP wire protocol". For v1 they're HTTP
routes inside the gateway process; tomorrow any of them can move to their
own Fly app, region, or runtime without touching the gateway.

These services are **part of the substrate** — the scenario-runner and the
hello-world bundles depend on them. The deployment-target distinction vs.
`examples/url-services/` is what makes them live in `orchestration/`:
they ship on `pax-backend-control`, not as a documentation example.

## Contents

| Service | Purpose |
|---|---|
| `echo/` | No-op. Returns `args` verbatim. The simplest gateway round-trip. |
| `delay/` | Controllable latency. Tests timeout and `providerError` paths. |
| `http-fetch/` | Real outbound HTTP against an allowlist. The "do something real" reference. |
| `mock-ai.v1/` | Canned responses keyed by `args` hash. **No billing logic.** A deterministic ai-shaped responder for the hello-world bundles and the scenario-runner. |

A *reference* `billing-mock.v1` service that demonstrates how an
operator could implement balance / credit / refund / spectator policy on
top of session observability lives in
[`../../examples/url-services/billing-mock.v1/`](../../examples/url-services/) —
it's documentation, **not part of the substrate's contract**, and
operators are free to ignore it.

Real production AI / vendor integrations are **operator-owned URL
services outside this repo**. See [plan](../../README.md) §"Why no
billing primitives".

## Source layout

`src/router.mts` is the gateway-facing dispatcher and catalog. Each
`src/services/<kind>.mts` module owns one reference service and exports a
`ReferenceUrlService` descriptor. The API gateway imports the catalog so
fallback `kindName -> URL` registrations stay in sync with the HTTP
routes that actually handle calls.
