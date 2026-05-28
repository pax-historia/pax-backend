import type { NemesisManifest } from "../_internal/types.mjs";

export default {
  nemesisId: "no-faults",
  description: "Baseline run with no injected faults.",
  actions: [{ type: "none" }],
} satisfies NemesisManifest;
