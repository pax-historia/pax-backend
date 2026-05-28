import { makeManifest, withoutOracles } from "../_shared/scenario.mjs";

export default makeManifest(
  "spectator-billing-block",
  "A spectator attempts an AI-shaped chat call and is refused before URL-service billing.",
  withoutOracles(
    "session-observability-accuracy",
    "faithful-api-dispatch",
    "host-event-durability",
  ),
);
