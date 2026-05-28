# `examples/url-services/`

Operator-facing reference URL services. These are examples of services that
an operator could register in the API gateway's `kindName -> URL` table; they
are not part of the substrate runtime contract and are never deployed by the
substrate itself.

| Service | Purpose |
|---|---|
| `billing-mock.v1/` | Worked example of applying credit, charge, refund, and spectator policy using the gateway's session context. |
