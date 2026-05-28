import { makeManifest, withoutOracles } from "../_shared/scenario.mjs";

export default makeManifest(
  "role-claim-flow",
  "A host promotion arrives as participationChanged and broadcasts updated state.",
  withoutOracles(
    "session-observability-accuracy",
    "faithful-api-dispatch",
    "idempotent-player-input",
  ),
);
