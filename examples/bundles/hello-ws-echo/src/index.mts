// hello-ws-echo — the smoke creator bundle.
//
// Authored in TypeScript with full SDK types. esbuild bundles this to
// dist/bundle.js as a script (IIFE) whose footer calls __pax_install on
// the default export. The compiled artifact is what the parent-actor reads
// from disk and ships to the isolated-vm child for eval.

import { defineBundle } from "@pax-backend/runtime-sdk";

export default defineBundle({
  manifest: {
    compatTagProduced: "smoke:v1",
    compatTagsAccepted: ["smoke:v1"],
    runtimeContractRequired: 1,
  },

  onWake(c, payload) {
    c.log.emit({ event: "bundle.onWake", payload });
  },

  onPlayerConnect(c, payload) {
    c.log.emit({ event: "bundle.onPlayerConnect", payload });
    c.ws.send(payload.playerId, {
      type: "ready",
      sessionId: payload.sessionId,
      connectedAt: payload.connectedAt,
    });
  },

  onPlayerMessage(c, payload) {
    c.log.emit({ event: "bundle.onPlayerMessage", payload });
    c.ws.send(payload.playerId, {
      type: "echo",
      sessionId: payload.sessionId,
      seq: payload.seq,
      body: payload.body,
    });
  },

  onPlayerDisconnect(c, payload) {
    c.log.emit({ event: "bundle.onPlayerDisconnect", payload });
  },
});
