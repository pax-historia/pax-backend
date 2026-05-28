# `moderation.audit.v1`

> **Status: schema-only spec.** Part of the historia-default proof (see
> [`docs-next/proofs/historia-default.md`](../../../docs-next/proofs/historia-default.md)).
> No live HTTP server runs for the proof — bundle calls are replayed from
> canned `api-responses` fixtures via the scenario-runner's existing
> replay-mode short-circuit. Production paxhistoria's
> [`/api/live/moderation/{verdict,ban}`](../../../../paxhistoria/app/api/live/moderation/)
> routes stay where they are.

URL service kind `moderation.audit.v1` is the operator-owned moderation
audit endpoint the [`historia-default`](../../bundles/historia-default/)
bundle calls when its moderation workflow reaches a verdict or initiates
a ban.

The substrate forwards the standard gateway envelope per
[`docs-next/contract/external-api-channel.md`](../../../docs-next/contract/external-api-channel.md)
§"API gateway envelope" and records the wire-grain round trip. Everything
inside `args` and `result` is opaque to the substrate.

## Args

Two ops, dispatched on the `op` discriminator:

```ts
type ModerationAuditV1Args =
  | {
      op: "recordVerdict";
      contentId: string;
      contentKind: "chat" | "action" | "cheatReason" | "preJumpForward";
      playerId: string;
      verdict: "ok" | "warn" | "flag" | "ban";
      reason: string;
      modelUsed?: string;
      classifierTrace?: unknown;
    }
  | {
      op: "recordBan";
      playerId: string;
      reason: string;
      durationMs?: number;        // omit for permanent
      sourceContentId?: string;
    };
```

`recordVerdict` writes one row to the moderation audit log
(paxhistoria's `moderation_verdicts` table). `recordBan` runs the ban
saga (paxhistoria's `lib/moderation/perform-ban.ts`): record to Postgres,
sync to Redis ban cache, and trigger fan-out.

**Cross-game ban enforcement** is handled separately by the substrate's
existing `DELETE /admin/players/:playerId` admin endpoint, which
force-disconnects the player from every game they're connected to
atomically and writes an audit event. The bundle does NOT use
`moderation.audit.v1` to enforce — only to record. Enforcement is the
host's call to substrate admin.

## Result

```ts
type ModerationAuditV1Result =
  | { ok: true; auditId: string }
  | { ok: false;
      errorCode: "validationError" | "providerError";
      detail?: unknown; };
```

## Trust gates

None billing-shaped. The bundle may call these ops freely; the URL
service may rate-limit per `gameId` if desired.

## What this URL service does NOT do

| Concern | Where it lives |
|---|---|
| Per-call ban-check (was paxhistoria's `checkBan`) | Not needed: substrate's `DELETE /admin/players/:id` force-disconnects banned players cluster-wide before the bundle ever sees them again |
| Ban-saga-failed alerts (was paxhistoria's `alertBanFailed`) | Substrate observability via `c.log.emit` + the BetterStack pipeline (per [`docs-next/subsystems/observability.md`](../../../docs-next/subsystems/observability.md)) |

These were on an earlier 4-op draft and were dropped because the
substrate's existing primitives cover them.

## Authoring fixtures for scenarios

Place canned responses in
`examples/bundles/historia-default/scenarios/<scenario>/fixtures/api-responses/`,
using the shared fixture format in [`../README.md`](../README.md). Suggested
coverage:

- A successful `recordVerdict` response.
- A successful `recordBan` response.
- A `validationError` response (for scenarios testing the bundle's
  recovery path).

The `moderation-flow` scenario in
[`docs-next/proofs/historia-default.md`](../../../docs-next/proofs/historia-default.md)
§5 exercises the full path: content flagged → `recordVerdict` →
`recordBan` → substrate `DELETE /admin/players/:id` → all games
force-disconnect the player.
