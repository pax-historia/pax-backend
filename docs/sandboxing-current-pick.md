# Sandboxing — current pick

> Stub. See [plan README](../README.md) §"Sandboxing — provisional".

**v1 pick:** `isolated-vm` inside `node child_process` per game, on shared
shard runners.

**Why not deeper:** the goal of v1 is validating the *shape* of the substrate
— contract, channels, resource model, test harness, redeploy story — by
building it end-to-end. Security depth is a tunable we revisit once we have
evidence on:

- Which channels actually get used heavily and which sit idle.
- Where the real performance ceilings are on the rebuilt Rivet substrate.
- Whether `isolated-vm`'s maintainer-risk story has materialized.
- Whether a Bun or successor isolate library has emerged as a better fit.

**Insurance shipped on day one:**

- The runtime adapter is a separate package from the SDK (`@pax-backend/runtime-ivm`).
- The child IPC schema is independent of the inner runtime; swapping
  runtimes is a per-game flag, not a contract change.
- The no-ivm conformance gate runs every release.

Revisit criteria are listed in the plan; this doc tracks the current decision
and the open evidence we're collecting.
