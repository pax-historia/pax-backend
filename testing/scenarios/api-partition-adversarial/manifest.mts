import type { ScenarioManifest } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "api-partition-adversarial",
  seed: "pax-api-partition-adversarial-v1",
  determinism: "medium",
  defaultMode: "load",
  defaultBackend: "live",
  defaultNemesis: "api-kind-partition-burst",
  description:
    "Forces a URL-service partition under active player traffic and asserts provider errors are typed, recorded, and followed by successful recovery.",
  oracleNames: ["faithful-api-dispatch", "crash-blast-radius", "history-completeness"],
} satisfies ScenarioManifest;
