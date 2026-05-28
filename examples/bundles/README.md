# `tooling/bundles/` — first-party hello-world creator bundles

One bundle per substrate feature. Each is the **minimal** demonstration of one
or two channels — not a real game. Step 9 of the plan's kickoff.

| Bundle | What it exercises |
|---|---|
| `hello-blob-rw/` | `c.blob` durability. Reads on `onWake`, writes every ~30s, logs via `c.log`. |
| `hello-state-rw/` | `c.state` durability with explicit `c.state.flush()` before a crash-test point. |
| `hello-ws-echo/` | The WS tunnel, idempotency keys, `sessionId` stability. Echoes every `onPlayerMessage` body back via `c.ws.send`. |
| `hello-ai-call/` | The API gateway + context envelope + wire-grain recording end-to-end. Invokes `c.api.invoke('mock-ai.v1', ...)` per connected player every minute. The URL service sees the `connectedSessions` snapshot. |
| `hello-multifeature/` | All of the above slowly enough to be readable in a tail of `GET /admin/history`. The integration smoke. |

Stub.
