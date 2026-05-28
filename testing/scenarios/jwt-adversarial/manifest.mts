import type { ScenarioManifest } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "jwt-adversarial",
  seed: "pax-jwt-adversarial-v1",
  determinism: "high",
  defaultMode: "load",
  defaultBackend: "live",
  defaultNemesis: "no-faults",
  description:
    "Attempts tampered, expired, and misrouted placement JWT handshakes; the parent must reject without opening a session.",
  oracleNames: [
    "allowed-only-connection",
    "history-completeness",
    "placement-contract-safety",
  ],
} satisfies ScenarioManifest;
