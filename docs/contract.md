# The substrate contract — plain language for creators

> Stub. The full contract is in [the plan README](../README.md) until this doc
> gets written for real.

What every bundle author needs to know:

- The substrate gives you lifecycle hooks (`onWake`, `onSleep`, `onPlayerConnect`,
  `onPlayerDisconnect`, `onPlayerMessage`, `onCapacityWarning`), storage tiers
  (`c.state` and `c.blob`), a WS channel to players (`c.ws.send`), one external
  API channel (`c.api.invoke`), and observability (`c.players.*`,
  `c.compute.budget`, `c.log`, `c.metrics`).
- The substrate **does not** give you `c.ai`, `c.entity`, `c.asset`,
  `c.resources`, or `c.moderation`. Whatever your operator wants to offer in
  that shape is registered as an `api.invoke` kind backed by their own URL
  service.
- The substrate has **no balances, no caps, no debits, no refunds**. Any
  billing semantics live in URL services the operator registers — see
  [why-no-billing.md](why-no-billing.md).
- Compute-plane resources (CPU, RAM, bandwidth, message rate, state/blob
  bytes, api-invocations-per-minute) **are** enforced by the substrate. See
  [compute-budgets-catalog.md](compute-budgets-catalog.md).

Step 11 of the plan's kickoff. The harness's oracle library and this doc must
be in lock-step.
