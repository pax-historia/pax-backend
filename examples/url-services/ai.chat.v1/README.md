# `ai.chat.v1`

> **Status: schema-only spec.** Part of the historia-default proof (see
> [`docs-next/proofs/historia-default.md`](../../../docs-next/proofs/historia-default.md)).
> No live HTTP server runs for the proof — bundle calls are replayed from
> canned `api-responses` fixtures via the scenario-runner's existing
> replay-mode short-circuit. Production paxhistoria's
> [`/api/simple-chat`](../../../../paxhistoria/app/api/simple-chat/route.ts)
> stays where it is.

URL service kind `ai.chat.v1` is the operator-owned AI completion endpoint
the [`historia-default`](../../bundles/historia-default/) bundle calls via
`c.api.invoke('ai.chat.v1', args)` whenever a workflow yields a `callAI`
command (chat responses, advisor responses, jump-forward streams, action
suggestions, moderation classification).

The substrate forwards the standard gateway envelope per
[`docs-next/contract/external-api-channel.md`](../../../docs-next/contract/external-api-channel.md)
§"API gateway envelope" and records the wire-grain round trip. Everything
inside `args` and `result` is opaque to the substrate.

## Args

Mirrors paxhistoria's existing `SimpleChatRequest` from
[`paxhistoria/lib/getSimpleAIResponse.ts`](../../../../paxhistoria/lib/getSimpleAIResponse.ts):

```ts
type AiChatV1Args = {
  modelUsed: string;
  promptStage: string;
  promptTemplate: string;
  prompt: string;
  presetID?: string;
  round?: number;
  countryID?: string;
  jsonSchema?: unknown;
  stream?: boolean;
  temperature?: number;
  maxThinkingTokens?: number;
  modelPackKey?: string;
  optionalData?: unknown;
  imageInlineData?: { mimeType: string; data: string }[];
  // splitPlayerIDs identifies which players the bundle wants billed for
  // this call (e.g. participants in a group chat). The service still
  // gates each playerId on participation.v1.get(...) — bundle cannot
  // bypass the spectator block by listing a spectator here.
  splitPlayerIDs: string[];
};
```

The substrate already supplies `gameId`, `triggeringSessionId`,
`triggeringJwtClaims`, `connectedSessions`, `bundleName`, `bundleCompatTag`,
`runId`, `traceId`, and `idempotencyKey` in `context` — the URL service
reads from there, not from args.

## Result

```ts
type AiChatV1Result =
  | { ok: true;
      text?: string;
      streamEvents?: Array<{
        type: "delta" | "message" | "done";
        text?: string;
        data?: unknown;
      }>;
      transactionUUID: string;
      cost?: number;
      inputTokens?: number;
      outputTokens?: number;
      modelUsed: string; }
  | { ok: false;
      errorCode:
        | "INSUFFICIENT_TOKENS"
        | "playerIsSpectator"   // new — see Trust gates below
        | "providerError"
        | "validationError";
      brokeUserIds?: string[];
      detail?: unknown; };
```

`transactionUUID` is also surfaced as the `X-Transaction-UUID` response
header, matching the existing paxhistoria pattern that ties LLM logs,
Statsig events, and token-ledger rows together for tracing.

The gateway buffers URL-service HTTP responses as JSON, so streamed
provider output is represented in proof fixtures as deterministic
`streamEvents` rather than a live `ReadableStream`.

## Trust gates (load-bearing — the proof depends on these)

For every `playerId` in `args.splitPlayerIDs`, the URL service MUST:

1. **Fetch participation:** call
   [`participation.v1.get`](../participation.v1/README.md)
   with `(playerId, gameId)`. **No caching** — fresh read every call,
   issued in parallel with the existing token-ledger / resource-ledger
   reads so the round-trip lands inside the existing latency envelope.
2. **Refuse to bill spectators:** if `participant === false`, return
   `{ ok: false, errorCode: "playerIsSpectator", brokeUserIds: [...] }`
   without dispatching to any provider. This is the
   substrate-trusted defense against compromised bundles billing
   non-participants.
3. **Per-session offline-spend cap** (operator policy, URL-service-side):
   if `playerId` is not in `context.connectedSessions[*].playerId` and the
   per-session offline-spend cap has been hit, refuse with
   `INSUFFICIENT_TOKENS`.
4. **Pre-flight cost-spike detection** (operator policy, URL-service-side):
   if the estimated cost for this call exceeds the per-call cap, refuse
   with `INSUFFICIENT_TOKENS`. This is the gate that has to be tightened
   *before* creators can ship arbitrary workflows in `blob.workflows`.

These checks live in `ai.chat.v1`'s implementation, NOT in the
substrate, per `docs-next/why/why-no-billing.md`.

## Provider routing, billing pipeline, telemetry

Owned by the URL service implementation; not visible to the substrate or
bundle. The reference production implementation lives in paxhistoria's
[`app/api/simple-chat/`](../../../../paxhistoria/app/api/simple-chat/) and
covers 14 vendor providers (Google, Vertex, OpenRouter, OneRouter,
Alibaba, Canopywave, Chutes, Grok, Anthropic, OpenAI, Zhipu, Friendli,
Piris), `lib/billing/rules/v1.ts` retail rules, `llm_logs` + `token_ledger`
writes, and Firestore balance updates. For the proof, none of that runs; the
scenario suite uses deterministic gateway reference responses and can replay
canned fixture responses.

## Authoring fixtures for scenarios

Place canned responses in
`examples/bundles/historia-default/scenarios/<scenario>/fixtures/api-responses/`.
Use the shared fixture format in [`../README.md`](../README.md): each fixture
record carries the request fingerprint the gateway computes from the stable
`{ kind, args }` replay key and a serialized gateway `rawInbound` body. A
small helper in the bundle test harness records live fixtures during
development and freezes them for replay.

The scenario-runner hard-fails with `replayCoverageGap` if the bundle
issues a call with no matching fixture — missing coverage shows up as a
scenario failure, never as a silent live call.
