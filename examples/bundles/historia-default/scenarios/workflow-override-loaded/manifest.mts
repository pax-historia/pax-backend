import { makeManifest, withoutOracles } from "../_shared/scenario.mjs";

export default makeManifest(
  "workflow-override-loaded",
  "A workflow override host event is accepted before chat execution.",
  withoutOracles("session-observability-accuracy", "faithful-api-dispatch"),
);
