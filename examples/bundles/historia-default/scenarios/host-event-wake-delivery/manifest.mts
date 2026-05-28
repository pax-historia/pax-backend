import { makeManifest, withoutOracles } from "../_shared/scenario.mjs";

export default makeManifest(
  "host-event-wake-delivery",
  "A wake-on-delivery moderation eject host event reaches the bundle.",
  withoutOracles(
    "session-observability-accuracy",
    "faithful-api-dispatch",
    "idempotent-player-input",
  ),
);
