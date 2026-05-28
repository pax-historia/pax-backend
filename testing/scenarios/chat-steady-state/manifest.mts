import type { ScenarioManifest } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "chat-steady-state",
  seed: "pax-chat-steady-state-v1",
  determinism: "medium",
  defaultMode: "load",
  defaultBackend: "live",
  description:
    "Baseline chat-like churn: create allowed players, connect clients, send JSON messages, and assert session, websocket, input, and history guarantees.",
  oracleNames: [
    "singleton-game",
    "allowed-only-connection",
    "unique-stable-sessionid",
    "session-observability-accuracy",
    "idempotent-player-input",
    "history-completeness",
    "placement-contract-safety",
  ],
} satisfies ScenarioManifest;
