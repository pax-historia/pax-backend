import type { ScenarioManifest } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "checkpoint-durability-consistency",
  seed: "pax-checkpoint-durability-consistency-v1",
  determinism: "high",
  defaultMode: "load",
  defaultBackend: "live",
  defaultNemesis: "runner-crash-on-await",
  description:
    "Writes matching state/blob markers across explicit flushes, interval checkpoints, Runner crashes, and planned evictions to prove checkpoint-window durability without state/blob skew.",
  oracleNames: [
    "singleton-game",
    "allowed-only-connection",
    "crash-blast-radius",
    "state-durability",
    "blob-durability",
    "history-completeness",
  ],
} satisfies ScenarioManifest;
