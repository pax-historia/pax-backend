import type { ScenarioManifest } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "shard-death-resilience",
  seed: "pax-shard-death-resilience-v1",
  determinism: "medium",
  defaultMode: "property",
  defaultBackend: "live",
  description:
    "Composes with shard-death-every-5m to assert that blob is the global recovery tier and shard loss does not corrupt session history.",
  oracleNames: [
    "singleton-game",
    "crash-blast-radius",
    "no-random-parent-crashes",
    "blob-durability",
    "migration-rollback-safety",
    "history-completeness",
    "placement-contract-safety",
  ],
} satisfies ScenarioManifest;
