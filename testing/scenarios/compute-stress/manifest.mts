import type { ScenarioManifest } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "compute-stress",
  seed: "pax-compute-stress-v1",
  determinism: "medium",
  defaultMode: "fuzz",
  defaultBackend: "live",
  description:
    "Compute-plane stress scenario focused on websocket throughput, API rate limiting, state/blob byte caps, and budget observability. It deliberately avoids billing-shaped resources.",
  oracleNames: [
    "singleton-game",
    "faithful-api-dispatch",
    "compute-plane-quotas",
    "crash-blast-radius",
    "state-durability",
    "blob-durability",
    "history-completeness",
  ],
} satisfies ScenarioManifest;
