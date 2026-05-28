# Why the substrate has no billing primitives

This is the design rule that keeps the substrate general-purpose.

> The substrate exists to be the trust seam for untrusted JavaScript and the
> faithful recorder of what happened. Adding even a minimal billing model
> ("per-session caps", "balances") would pull in pricing, refunds, currency,
> regulatory shape, and accounting semantics that vary wildly per operator,
> and the moment a second operator showed up the substrate would fork.

The clean separation:

- **Substrate** owns compute-plane resources (CPU, RAM, bandwidth, message
  rate, state/blob bytes, api-invocations-per-min) because only the runtime
  can meter them. It owns session observability because only the substrate
  knows who is connected to what at any moment.
- **URL services** own everything billing-shaped — balances, caps, debits,
  refunds, spectator rules, credit grants, hot-row throughput, revenue
  share, regulatory event emission, anything else. They use the substrate's
  session observability (the `connectedSessions` snapshot in every
  `api.invoke` context envelope, plus the admin session endpoints) to make
  whatever trust decisions their billing model needs.
- **The seam between them** is one HTTP envelope, defined in
  [contract-spec.md](contract-spec.md). The substrate is opinion-free about
  `args` and `result` body contents.

The reference `billing-mock.v1` URL service in
`examples/url-services/billing-mock.v1/` is a worked example of how an
operator could implement balances/credits/refunds on top of this seam. It is
**not** part of the substrate's contract; tests against it live with the
service, not in the substrate's release gate.

## What would go wrong if billing lived here?

Even "small" billing concepts create policy gravity:

- A balance implies currency, precision, refund semantics, chargeback shape,
  audit retention, and regulatory expectations.
- A cap implies who owns the cap, when it resets, whether spectators count,
  and what happens to in-flight work when the cap is crossed.
- A debit log implies idempotency keys, reconciliation, operator accounting,
  dispute handling, and backfills.

Those decisions are valid product choices, but they are not universal runtime
choices. The substrate instead guarantees that URL services receive accurate
session context and that every API round trip is recorded at wire grain, so
operators can build and test their own policies without forking the runtime.
