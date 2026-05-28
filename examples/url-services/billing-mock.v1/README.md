# `billing-mock.v1`

Worked example of an operator-owned URL service. It accepts the standard
gateway envelope at `POST /invoke`, reads `connectedSessions`,
`triggeringSessionId`, `triggeringJwtClaims`, and `idempotencyKey`, and then
applies its own credit/charge/refund policy.

This is deliberately outside `orchestration/` and outside shared protocol
types. The substrate forwards the envelope and records the response; this
service owns every account-shaped rule and data structure.

## Actions

All actions are passed in `args`:

| Action | Shape | Result |
|---|---|---|
| `quote` | `{ action, playerId }` | Current account snapshot. |
| `grant` | `{ action, playerId, amount, memo? }` | Adds credits. |
| `charge` | `{ action, playerId, amount, memo?, allowOffline?: false }` | Subtracts credits only if the player is connected and the triggering session is not a spectator. |
| `refund` | `{ action, eventId, memo? }` | Reverses a prior charge once. |

Business denials return HTTP 200 with `result.approved: false`; malformed
requests return an HTTP error body. That keeps URL-service policy separate
from substrate dispatch failures.
