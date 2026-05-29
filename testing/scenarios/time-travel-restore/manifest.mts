import type { ScenarioManifest } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "time-travel-restore",
  seed: "pax-time-travel-restore-v1",
  determinism: "high",
  defaultMode: "load",
  defaultBackend: "live",
  defaultNemesis: "no-faults",
  description:
    "Views an older retained checkpoint through the admin snapshot API, restores it forward, and verifies the next wake materializes the restored state/blob root.",
  oracleNames: [
    "singleton-game",
    "allowed-only-connection",
    "state-durability",
    "blob-durability",
    "history-completeness",
  ],
} satisfies ScenarioManifest;
