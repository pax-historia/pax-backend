# `runtime/parent-actor/`

The platform-trusted RivetKit actor that owns one game. **The parent is a
dumb pipe; the child is the game** (see [plan](../../README.md)
§"Architectural philosophy"). Responsible for:

- WS lifecycle, session id generation, allowed-players gate (guarantees #2, #3)
- Compute-plane quota enforcement (guarantee #7)
- IPC broker between child and the rest of the cluster
- Storage tier dispatch (`c.state`, `c.blob`)
- Forwarding `c.api.invoke` calls to the API gateway with the context envelope
- Writing every channel call / lifecycle event / session transition / api
  round trip to the history (guarantee #14)

Stub. Implementation lands in step 7 of the plan's kickoff.
