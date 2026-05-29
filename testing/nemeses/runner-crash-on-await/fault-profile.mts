import type { NemesisManifest } from "../_internal/types.mjs";

export default {
  nemesisId: "runner-crash-on-await",
  description:
    "Crashes one Runner process when a scenario explicitly awaits crash-runner. Used to prove native-crash blast radius and replacement wake behavior without perturbing unrelated scenarios in the full nemesis matrix.",
  actions: [
    {
      type: "crash-runner",
      trigger: "on-await",
      selection: "most-active",
      runnerIndex: 1,
    },
  ],
} satisfies NemesisManifest;
