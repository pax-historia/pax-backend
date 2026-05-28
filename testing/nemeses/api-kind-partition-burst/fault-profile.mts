import type { NemesisManifest } from "../_internal/types.mjs";

export default {
  nemesisId: "api-kind-partition-burst",
  description:
    "Temporarily rewires mock-ai.v1 to an unroutable provider URL, then restores the previous API-kind registration.",
  actions: [
    {
      type: "api-kind-partition",
      afterMs: 5_000,
      durationMs: 1_500,
      kindName: "mock-ai.v1",
      partitionUrl: "http://127.0.0.1:1/_partitioned",
    },
  ],
} satisfies NemesisManifest;
