import type { ScenarioManifest } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "conditional-put-fencing",
  seed: "pax-conditional-put-fencing-v1",
  determinism: "high",
  defaultMode: "load",
  defaultBackend: "live",
  defaultNemesis: "no-faults",
  description:
    "Forces a stale active owner to lose the state root conditional PUT race, then verifies it stands down and the next wake materializes the winning root.",
  oracleNames: [
    "singleton-game",
    "allowed-only-connection",
    "state-durability",
    "blob-durability",
    "history-completeness",
  ],
} satisfies ScenarioManifest;
