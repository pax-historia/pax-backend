import { makeWorkload } from "../../_shared/scenario.mjs";

export default makeWorkload({
  scenarioId: "host-event-wake-delivery",
  gameIdPrefix: "historia-host-event-wake",
  postMessageHostEvents: [
    {
      eventType: "moderationEject",
      wakeOnDelivery: true,
      payload: { playerId: "player-1", reason: "scenario moderation eject" },
    },
  ],
});
