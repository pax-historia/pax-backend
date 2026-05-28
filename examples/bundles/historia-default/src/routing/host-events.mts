import { participationRecordFromHostEvent } from "../modules/player-management.mjs";
import type { HostEventInput } from "../modules/types.mjs";

export async function dispatchHostEvent(input: HostEventInput): Promise<boolean> {
  if (input.eventType === "participationChanged") {
    const player = participationRecordFromHostEvent(input.payload, input.ctx.now());
    if (!player) return false;
    input.ctx.setPlayerRecord(player);
    input.ctx.appendWorkingEvent("participation.changed", {
      playerId: player.playerId,
      participant: player.participant,
      entityId: player.entityId,
    });
    await input.c.ws.send("all", {
      type: "participation.changed",
      eventId: input.eventId,
      playerId: player.playerId,
      participant: player.participant,
      entityId: player.entityId,
    });
    return true;
  }

  if (input.eventType === "moderationEject" || input.eventType === "moderation.ejected") {
    input.ctx.appendWorkingEvent("moderation.ejected", input.payload);
    await input.c.ws.send("all", {
      type: "moderation.ejected",
      eventId: input.eventId,
      payload: input.payload,
    });
    return true;
  }

  return false;
}
