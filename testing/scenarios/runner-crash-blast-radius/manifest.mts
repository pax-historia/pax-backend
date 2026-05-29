import type { ScenarioManifest } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "runner-crash-blast-radius",
  seed: "pax-runner-crash-blast-radius-v1",
  determinism: "high",
  defaultMode: "load",
  defaultBackend: "live",
  defaultNemesis: "runner-crash-on-await",
  description:
    "Crashes a Runner under active games and verifies the Broker bounds the affected set, replaces the child process, and re-wakes games from storage.",
  oracleNames: [
    "singleton-game",
    "allowed-only-connection",
    "crash-blast-radius",
    "state-durability",
    "history-completeness",
  ],
} satisfies ScenarioManifest;
