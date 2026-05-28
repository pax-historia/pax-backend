import type { ScenarioManifest } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "compromised-bundle-adversarial",
  seed: "pax-compromised-bundle-adversarial-v1",
  determinism: "high",
  defaultMode: "load",
  defaultBackend: "live",
  defaultNemesis: "no-faults",
  description:
    "A hostile bundle attempts to send to a player with no connected session; the parent must reject the target without crashing.",
  oracleNames: [
    "allowed-only-connection",
    "compute-plane-quotas",
    "crash-blast-radius",
    "history-completeness",
  ],
} satisfies ScenarioManifest;
