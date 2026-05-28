# `testing/oracles-lib/`

Reusable oracle helpers. **Substrate-side only** — every oracle here
reads the history file and asserts a property the substrate must uphold
(see [plan](../../README.md) §"Strong platform guarantees").

Billing-shaped oracles (balance correctness, refund integrity, hot-row
throughput, etc.) live in operator-side test suites that target their own
URL services. The `billing-mock.v1` reference URL service in
[`../../examples/url-services/billing-mock.v1/`](../../examples/url-services/)
is the worked example; the tests against it live with that service, not
in this repo's release gate.

## Sub-layout

```
src/guarantees/
  singleton-game.ts                 # README guarantee #1
  allowed-only-connection.ts        # #2
  unique-stable-sessionid.ts        # #3
  ...                               # one file per Strong Platform Guarantee
  index.ts                          # the canonical #N → filename map
```

**Guarantee oracle files use stable names, not numbers** —
decouples filesystem identity from prose ordering in the plan README.
See [`../README.md`](../README.md) for the full numbered list and the
naming convention rationale.

Current source pass ships the package skeleton plus one named oracle function
per Strong Platform Guarantee. Each oracle reads structured history events and
returns `pass`, `fail`, or `inconclusive`; the scenario-runner will decide how
strictly to treat inconclusive results for each run mode.
