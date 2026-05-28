# Registered API Kinds

API kinds are versioned names mapped to URL services. The control plane stores
operator registrations under `api_kinds:<kindName>` and exposes:

- `POST /admin/api-kinds` with `{ kindName, url }`
- `GET /admin/api-kinds`
- `GET /admin/api-kinds/:kindName`
- `DELETE /admin/api-kinds/:kindName`

## First-party reference kinds (ship in `orchestration/url-services/`)

| Kind | URL service | Purpose |
|---|---|---|
| `echo.v1` | `echo/` | No-op. Returns `args` verbatim. |
| `delay.v1` | `delay/` | Controllable latency. |
| `http.fetch.v1` | `http.fetch/` | Real outbound HTTP against an allowlist. |
| `mock-ai.v1` | `mock-ai.v1/` | Canned ai-shaped responses keyed by `args` hash. No billing. |

## Reference (not contract) kinds

| Kind | URL service | Purpose |
|---|---|---|
| `billing-mock.v1` | `billing-mock.v1/` | Worked example of operator-owned billing on top of session observability. **Not part of the substrate's contract.** |

## Operator-owned kinds

Listed per deployment in operator configuration; the substrate has no
opinion. See [the plan README](../../README.md) §"External API channel" for the
URL-per-kind model.
