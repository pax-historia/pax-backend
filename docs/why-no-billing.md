# Why the substrate has no billing primitives

> Stub. See [plan README](../README.md) §"Why no billing primitives" for the
> definitive reasoning.

Two-line summary:

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
`orchestration/url-services/billing-mock.v1/` is a worked example of how an
operator could implement balances/credits/refunds on top of this seam. It is
**not** part of the substrate's contract; tests against it live with the
service, not in the substrate's release gate.
