# `examples/url-services/`

Operator-facing reference URL services. These are examples of services that
an operator could register in the API gateway's `kindName -> URL` table; they
are not part of the substrate runtime contract and are never deployed by the
substrate itself.

| Service | Purpose |
|---|---|
| `ai.chat.v1/` | Schema-only Pax-historia AI completion spec for the `historia-default` proof. |
| `flag.search.v1/` | Schema-only Pax-historia flag-search spec for jump-forward fixture replay. |
| `moderation.audit.v1/` | Schema-only Pax-historia moderation audit spec for verdict/ban recording. |
| `participation.v1/` | Schema-only Pax-historia participation-state spec; keeps participant/spectator policy outside the substrate. |
| `projection.sync.v1/` | Schema-only Pax-historia host-projection sync spec for bundle-only-knowable metadata. |
| `billing-mock.v1/` | Worked example of applying credit, charge, refund, and spectator policy using the gateway's session context. |

## Schema-only fixture contract

The five `historia-default` specs above do not ship HTTP servers. Scenario
fixtures are gateway wire records consumed by the API gateway replay store,
not raw URL-service payload files.

Each fixture record may live in a `.json` file, in a `.jsonl` file, or inside
a `records` array. Lookup uses the record's `fingerprint` field; naming files
`<fingerprint>.json` is only a convention for humans. The replay fingerprint is
the SHA-256 hex digest of the canonical `{ kind, args }` replay key, not the
full gateway envelope, so volatile session and trace context does not make
fixtures one-run-only. A replayable record must include at least:

```json
{
  "event": "api.invoke",
  "fingerprint": "...",
  "statusCode": 200,
  "rawInbound": "{\"result\":{\"ok\":true}}"
}
```

For successful URL-service HTTP responses, `rawInbound` is the serialized
gateway response body `{ "result": <service-defined result> }`. For non-2xx
URL-service responses, `rawInbound` is the serialized `{ "error": "...",
"detail": ... }` body and the bundle receives a substrate `providerError`
with that body preserved in `detail`. Missing fixture fingerprints hard-fail
with `replayCoverageGap`; the gateway never falls through to a live call in
replay mode.
