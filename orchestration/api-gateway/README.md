# `orchestration/api-gateway/`

The substrate's only egress to operator-owned URL services. Implements
[plan](../../README.md) §"External API channel":

1. Flat `kindName → URL` registry loaded at boot.
2. Check api-invocations-per-min compute budget (reject `apiRateExceeded`).
3. Look up URL (reject `kindUnknown`).
4. Build the library-defined context envelope: `gameId`, `triggeringSessionId`,
   `triggeringJwtClaims`, full `connectedSessions` snapshot, `bundleName`,
   `bundleCompatTag`, `runId`, `idempotencyKey`.
5. Fingerprint = `sha256(serialize(outbound))`.
6. Live mode: POST to URL with `X-Gateway-Envelope-Version: 1`, record both
   raw outbound + raw inbound at wire grain, return verbatim.
7. Replay mode: lookup recorded inbound by fingerprint; **hard-fail with
   `replayCoverageGap` if no match** (no silent fall-through to live).

The gateway has **zero opinion** about `args` or `result` bodies. It does not
interpret billing, validate kind-specific schemas, or model debits. Strong
Platform Guarantee #5 is the contract.

Step 5 of the plan's kickoff.

Stub.
