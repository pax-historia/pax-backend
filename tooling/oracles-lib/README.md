# `tooling/oracles-lib/`

Reusable oracle helpers. **Substrate-side only** — every oracle here reads
the history file and asserts a property the substrate must uphold (see
[plan](../../README.md) §"Strong platform guarantees").

Billing-shaped oracles (balance correctness, refund integrity, hot-row
throughput, etc.) live in operator-side test suites that target their own
URL services. The `billing-mock.v1` reference URL service in
`orchestration/url-services/billing-mock.v1/` is the worked example; the
tests against it live with that service, not in this repo's release gate.

Stub.
