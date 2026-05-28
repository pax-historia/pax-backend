# Gateway HTTP envelope

> Layer: **Reference catalog**

The wire shape for every HTTP call the substrate's API gateway sends to
a URL service. This is the contract URL services implement against.

## Header

```http
POST <registered URL>
Content-Type: application/json
X-Gateway-Envelope-Version: 2
X-Gateway-Request-Id: <uuid>
X-Gateway-Game-Id: <gameId>
X-Gateway-Kind: <kindName>
X-Gateway-Mode: live
traceparent: 00-<trace_id>-<span_id>-01
tracestate: <optional W3C tracestate>
```

| Header | Meaning |
|---|---|
| `X-Gateway-Envelope-Version` | Always `2` at this contract version. URL services dispatch on this header to know which body schema to parse |
| `X-Gateway-Request-Id` | UUID, unique per call. URL services use it as a dedup key if needed |
| `X-Gateway-Game-Id` | The calling game. Mirrors `body.context.gameId` |
| `X-Gateway-Kind` | The kind name. Mirrors `body.context` does not duplicate; this is the only place |
| `X-Gateway-Mode` | Always `live` from the URL service's perspective. The substrate short-circuits replay before HTTP |
| `traceparent` / `tracestate` | W3C trace context |

## Request body

```ts
interface GatewayHttpRequestBody {
  args: unknown;                             // opaque to substrate; whatever the bundle passed
  context: {
    gameId: string;
    triggeringSessionId: string | null;
    triggeringJwtClaims: Record<string, unknown> | null;
    connectedSessions: readonly ConnectedSessionSnapshot[];
    bundleName: string;
    bundleCompatTag: string;
    runId: string | null;                    // scenario-runner runs only; null in production
    traceId: string | null;
    idempotencyKey: string | null;
  };
}

interface ConnectedSessionSnapshot {
  sessionId: string;
  playerId: string;
  connectedAt: string;                       // ISO timestamp
}
```

### Field details

| Field | Source | Notes |
|---|---|---|
| `args` | Bundle (`c.api.invoke(kind, args)`) | Substrate doesn't inspect; URL service defines its own schema |
| `context.gameId` | Substrate | The calling game |
| `context.triggeringSessionId` | Substrate | Set when the call originates from `onPlayerMessage`; `null` for lifecycle-triggered calls (`onWake`, `onSleep`, `onCapacityWarning`, `onHostEvent`) |
| `context.triggeringJwtClaims` | Substrate (verbatim from the router-signed WS JWT, including the vercel-backend-supplied `passthrough` block) | `null` when `triggeringSessionId` is `null` |
| `context.connectedSessions` | Substrate | Snapshot at dispatch time. Accurate per guarantee #4 |
| `context.bundleName` | Substrate | The bundle that issued the invoke |
| `context.bundleCompatTag` | Substrate | `== bundle.manifest.compatTagProduced` |
| `context.runId` | Substrate | Scenario-runner run id when the call is part of a scenario invocation; `null` in production. URL services that want a stable per-call identifier should use `X-Gateway-Request-Id` instead |
| `context.traceId` | Substrate | W3C trace_id (mirrors `traceparent` header); `null` if no trace context arrived |
| `context.idempotencyKey` | Bundle (via `options.idempotencyKey`) | Pass-through; substrate doesn't dedupe |

## Response body — success

```http
HTTP/1.1 200 OK
Content-Type: application/json

{ "result": <opaque, URL-service-defined> }
```

The substrate hands `result` verbatim to the bundle as
`{ ok: true, result }`.

## Response body — failure

Any non-2xx status code:

```http
HTTP/1.1 4xx or 5xx
Content-Type: application/json

{
  "error": "<URL-service-defined error code>",
  "detail": <optional opaque>
}
```

The substrate maps to `{ ok: false, error: 'providerError', detail }`
on the bundle side. The URL service's `error` and `detail` are
preserved verbatim in `detail`.

URL services are free to choose any status code; the substrate doesn't
parse status semantics. Common conventions:

| Status | Convention |
|---|---|
| `400` | Malformed `args` or `context` |
| `403` | Trust-rule violation (player not connected, spectator, etc.) |
| `404` | Referenced entity not found |
| `409` | Idempotency-key conflict |
| `429` | URL-service-side rate limit (separate from substrate's `api-invocations-per-min`) |
| `500` | URL service internal error |
| `503` | Downstream (vendor) unavailable |

## Substrate-owned failure modes

These never reach the URL service — they're returned by the substrate
without making the HTTP call:

| Bundle-side error | When | Notes |
|---|---|---|
| `kindUnknown` | The kind isn't in the registry | `POST /admin/api-kinds` to register first |
| `apiRateExceeded` | `api-invocations-per-min` budget exhausted | Per-game sliding window |
| `replayCoverageGap` | Replay mode and no fixture matches | Hard fail; not retryable |

## Wire-grain recording

Every live-mode call generates an `api.invoke.wire` history event:

```jsonc
{
  "event": "api.invoke.wire",
  "ts": "ISO with ns precision",
  "shardId": "...",
  "pax_seq": 12345,
  "gameId": "...",
  "sessionId": null | "...",
  "traceId": null | "...",
  "requestId": "uuid",
  "kind": "ai.chat.v1",
  "mode": "live",
  "fingerprint": "<64 hex>",
  "statusCode": 200,
  "durationMs": 142,
  "raw_outbound": { /* full envelope above */ },
  "raw_inbound": { /* full response body */ }
}
```

The replay fingerprint is `sha256(canonicalize({ kind, args }))`.
Canonicalization is deterministic (sorted keys, no whitespace). The live
provider still receives the full envelope, including context, but volatile
context fields such as `runId`, `traceId`, `sessionId`, and connection
timestamps are intentionally excluded from the replay key so canned scenario
fixtures can be reused across runs.

## Replay mode

When the substrate is in replay mode (`PAX_API_REPLAY_FIXTURES_PATH`
set), the gateway:

1. Builds the envelope as above.
2. Computes the fingerprint.
3. Looks up the fingerprint in the fixture directory.
4. Returns the recorded response (or `replayCoverageGap` on miss).

The URL service never receives the HTTP call. From the URL service's
perspective, every call is `live`.

## Envelope version evolution

`X-Gateway-Envelope-Version: 2` is the current version. The substrate
bumps the version when the body schema changes in a non-additive way
(e.g. renamed field, removed field, semantic change).

Version bumps are independent of:

- **Axis A** (bundle ↔ substrate) — `runtimeContractRequired` integer.
- **Axis C** (bundle ↔ URL service) — kind-name version suffix like
  `ai.chat.v1`.

URL services can support multiple envelope versions simultaneously by
dispatching on the header. The substrate sends one version at a time
(set at the gateway's build time).

## Additive field changes within a version

Within `X-Gateway-Envelope-Version: 2`, the substrate may add new
optional fields to `context` without bumping the version. URL services
should ignore unknown fields. Non-additive changes (renaming, removing,
or semantically changing a field) require a version bump.

## Cross-references

- [`contract/external-api-channel.md`](../contract/external-api-channel.md)
  — bundle-side `c.api.invoke`
- [`subsystems/api-gateway.md`](../subsystems/api-gateway.md) — gateway
  internals
- [`event-schema.md`](event-schema.md) — `api.invoke.wire` event shape
- [`error-codes.md`](error-codes.md) — full error taxonomy
- [`operator-overlays/url-service-authoring.md`](../operator-overlays/url-service-authoring.md)
  — implementing a URL service
- [`why/why-url-per-kind.md`](../why/why-url-per-kind.md)
