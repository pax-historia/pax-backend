import type { ScenarioManifest } from "@pax-backend/scenario-runner";

export default {
  scenarioId: "compute-stress",
  seed: "pax-compute-stress-v2",
  determinism: "high",
  defaultMode: "load",
  defaultBackend: "live",
  defaultNemesis: "no-faults",
  description:
    "Compute-plane edge scenario focused on CPU timeout, websocket rate and bandwidth, state/blob caps, API rate limiting, and budget observability. It deliberately avoids billing-shaped resources.",
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
