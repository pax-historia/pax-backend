import type { NemesisManifest } from "../_internal/types.mjs";

export default {
  nemesisId: "shard-death-every-5m",
  description:
    "Every five minutes, terminate one eligible shard and let the orchestration layer replace it. Used to prove blob-backed recovery semantics.",
  actions: [
    {
      type: "kill-shard",
      everyMs: 300_000,
      selection: "least-recently-killed",
      replacement: "let-orchestrator-replace",
    },
  ],
} satisfies NemesisManifest;
