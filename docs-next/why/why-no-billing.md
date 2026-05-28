# Why: no billing primitives in the substrate

> Layer: **Why**

## Considered

A substrate that owns a small set of billing primitives directly. Earlier
plan iterations proposed:

- `Balance` unit
- `Reservation` / `commit` / `release` two-phase resource accounting
- `DebitLogEntry` audit ledger
- `applyExternalMutation` / `readBalance` admin endpoints
- `authorizedDebits` / `debited` fields on the `api.invoke` wire shape
- Per-session resource caps (`sessionResourceCaps`)
- A `gamePool` and per-game token allocation
- Hot-row sharding inside the substrate for ledger throughput

The motivating use case was: a bundle calls `c.api.invoke('ai.chat.v1', ...)`,
the substrate could enforce "this player has tokens left," provide
two-phase reservation against a credit pool, and refund on bundle error.

## Why we said no

Two operators using the same substrate could mean entirely different things
by "ai-token" (one charges per response; another charges per character;
another charges per provider call; another caps per session; another caps
per game). Baking any one model into the substrate forks it the moment a
second consumer shows up with a different model.

Concretely, every billing-shaped primitive the substrate could own would
have to commit to:

- A currency unit (tokens? cents? credits? gold?)
- A pricing model (per-call? per-result-size? subscription? prepaid pool?)
- Refund semantics (full? partial? expiring? cross-game?)
- Spectator semantics (do spectators consume? do they have their own cap?)
- Regulatory shape (audit log retention, transaction reversal, tax)

None of these are universal across operators, even within the gaming
domain. A substrate that picked any one set would either be over-fit to
that operator (and useless to anyone else) or expose a configuration
surface so large that picking the substrate adds more work than writing
the billing from scratch.

The cleaner separation: the substrate is honest about who-was-where-when
(session observability), URL services do whatever billing model the
operator wants, and the two communicate via a simple HTTP envelope. The
vercel backend's `ai.chat.v1` URL service implements all of the above
against its own storage, its own pricing logic, its own refund rules.
The substrate's role reduces to "tell `ai.chat.v1`, on every call, exactly
which sessions are connected, what their JWT claims are, and which session
triggered this call."

That information is enough — `ai.chat.v1` can refuse to bill a session
that isn't connected, refuse a spectator, cap per-session spend, refund
when the substrate reports `providerError`, etc. All without the substrate
having a billing vocabulary.

## What would change our mind

The substrate adds billing primitives if and only if **every URL service
implementing billing turns out to need the exact same primitive** and that
primitive is so general it has no per-operator variation. Two cases would
qualify:

1. The substrate finds itself proxying a billing-shaped operation between
   two URL services because no single service has enough context. (We
   don't see this today.)
2. Compute-plane budgets and business-plane resources converge into the
   same vocabulary — i.e. tokens become a metered substrate resource the
   way memory and bandwidth are. (We don't expect this; tokens vary too
   much.)

Until then, the rule is firm: **no billing words in the substrate's
contract.** No `Balance`. No `Reservation`. No `DebitLogEntry`. The word
"billing" appears in the substrate docs only to say it's not in scope.

## See also

- [`vision/non-goals.md`](../vision/non-goals.md)
- [`contract/external-api-channel.md`](../contract/external-api-channel.md) — the channel that replaces all of this
- [`operator-overlays/billing-policy.md`](../operator-overlays/billing-policy.md) — how the vercel backend implements billing on top of session observability
