# `docs-next/` — the substrate's desired-state architecture tree

This tree is the canonical description of what the **substrate** is supposed to
be when it ships. It is not a status report. It does not describe what code
exists today; it describes what the system looks like once everything in it is
built. If a page here disagrees with [`/Users/eli/Documents/GitHub/pax-backend/README.md`](../README.md), this tree is
correct and the legacy doc is a historical artifact.

The existing [`docs/`](../docs/) directory and the root README are frozen as
implementation notes until this tree is internally coherent. Once it is, they
get demoted to "historical / current-state" material and `docs-next/` is
promoted to `docs/`.

## How to read the tree

Every page declares its **layer** at the top:

| Layer | What lives there | Who consumes it |
|---|---|---|
| **Vision** | What the substrate is, what it isn't, who it serves, how the pieces compose | Every reader, on first contact |
| **Why** | Single-purpose justification of a load-bearing design choice — the rejected alternative and the reasoning | Anyone tempted to re-litigate the decision |
| **Contract** | The creator-facing surface (`@pax-backend/runtime-sdk` types, bundle manifest, lifecycle hooks, `c.*` API, history events). Stable; SDK and IPC code is written against these | Bundle authors, SDK implementors |
| **Subsystems** | One doc per substrate-internal component. Purpose, owns/doesn't-own, inputs/outputs, failure model, observability | Substrate engineers |
| **Operator overlays** | Patterns Pax-historia happens to use to compose URL services with substrate primitives (billing, participation, moderation, projection sync). These are **not substrate** — they're worked examples of what an operator can build on top | URL service authors, integrators |
| **Proofs** | Concrete validations of the substrate-shape, today specifically `historia-default` | The team running the proof |
| **Reference** | Machine-shaped catalogs: admin API endpoints, gateway envelope, history event schema, error codes, metrics, JWT claims, WS subprotocol. These are the wire contracts | Anyone implementing against the substrate from outside |

A reader looking for the system in their head reads **vision/** then
**subsystems/** in any order. A reader implementing against the substrate
reads **contract/** and **reference/**. A reader trying to understand why we
made a particular choice reads **why/**.

## The substrate has exactly one consumer (Pax-historia)

That consumer is shaped like:

- A **vercel platform frontend wrapper** — the browser-facing app Pax-historia
  ships on Vercel.
- A **vercel backend** — the Next.js server on Vercel that owns identity,
  billing, metadata, and registers URL service kinds.
- The **substrate** — this repo.

These three names are normative. They replace the older
operator/host/platform/library/developer mix. See
[`vision/parties-and-roles.md`](vision/parties-and-roles.md).

The substrate is designed as if it were general-purpose — that discipline
produced better choices. Production deploys exactly one tenant. If a sentence
in here wants to introduce a "tenant" or "multi-operator" abstraction, that
sentence is wrong.

## Top-level layout

```
docs-next/
  README.md                              ← you are here
  vision/                                ← what we're building, what we're not
    substrate-overview.md
    parties-and-roles.md
    boundaries-and-layers.md
    glossary.md
    non-goals.md
    guarantees.md
    trust-model.md
  why/                                   ← justification per load-bearing decision
    why-no-billing.md
    why-no-async-games.md
    why-no-scheduled-wakeups.md
    why-opaque-compat-tags.md
    why-keyed-blob-not-snapshot.md
    why-tigris-canonical.md
    why-url-per-kind.md
    why-isolated-vm-in-child.md
    why-no-audience-axis.md
    why-no-role-units.md
    why-rivet-vendored.md
  contract/                              ← creator-facing surface
    creator-runtime.md
    lifecycle-and-wake.md
    storage.md
    compute-budgets.md
    external-api-channel.md
    bundle-compatibility.md
    history-events.md
  subsystems/                            ← substrate-internal pieces
    placement-and-wake.md
    control-plane-admin-api.md
    api-gateway.md
    parent-actor.md
    child-runner-sandbox.md
    bundle-storage.md
    scenario-runner.md
    observability.md
    redeploy-and-drain.md
  operator-overlays/                     ← patterns, not substrate primitives
    url-service-authoring.md
    billing-policy.md
    participation-and-roles.md
    moderation-policy.md
    projection-sync.md
  proofs/
    historia-default.md
  reference/                             ← wire contracts and catalogs
    admin-api.md
    placement-api.md
    gateway-envelope.md
    ws-subprotocol.md
    jwt-claims.md
    ipc-protocol.md
    event-schema.md
    metrics-catalog.md
    error-codes.md
```

## Authoring rules

- **No status reports.** Don't write "this is implemented" or "this is TODO."
  Write the system as it will exist.
- **No re-litigating closed decisions.** If you want to revisit a `why/`
  doc, do it in a separate document or a code review, not by editing the
  `why/` doc itself. The `why/` docs are records.
- **Cross-link, don't repeat.** Each fact lives in exactly one place. Every
  other place links there.
- **The three actors are normative.** Use "vercel backend" not "host product"
  or "operator." Use "vercel platform frontend wrapper" not "frontend" or
  "client app." Use "substrate" not "library" or "platform."
- **`why/` files are short.** One page per rejection, three sections: what
  we considered, why we said no, what would change our mind.
- **Subsystem pages follow the template.** Purpose, owns, doesn't own,
  inputs, outputs, failure model, trust position, observability surface,
  end-state contract. See [`subsystems/parent-actor.md`](subsystems/parent-actor.md)
  for the canonical example.
