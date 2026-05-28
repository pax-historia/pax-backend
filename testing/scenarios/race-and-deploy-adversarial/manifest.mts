import type { ScenarioManifest } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "race-and-deploy-adversarial",
  seed: "pax-race-deploy-v1",
  determinism: "high",
  defaultMode: "load",
  defaultBackend: "live",
  defaultNemesis: "no-faults",
  description:
    "Adversarial host-event, sleep, reconnect, and bundle-flip collision scenario.",
  oracleNames: [
    "singleton-game",
    "allowed-only-connection",
    "unique-stable-sessionid",
    "bundle-compatibility-safety",
    "migration-rollback-safety",
    "placement-contract-safety",
    "host-event-durability",
    "state-durability",
    "blob-durability",
    "crash-blast-radius",
    "history-completeness",
  ],
} satisfies ScenarioManifest;
