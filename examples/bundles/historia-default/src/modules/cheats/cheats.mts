import type { PlayerMessageHandler } from "../types.mjs";
import { readBodyType, readString } from "../util.mjs";

export const handleCheatsMessage: PlayerMessageHandler = async (input) => {
  if (readBodyType(input.body) !== "cheats.reason") return false;
  const reason = readString(input.body["reason"], "No reason supplied.");
  input.ctx.appendWorkingEvent("cheats.reason", {
    playerId: input.playerId,
    seq: input.seq,
    reason,
  });
  await input.c.ws.send("all", {
    type: "cheats.reasonBroadcast",
    seq: input.seq,
    playerId: input.playerId,
    reason,
  });
  return true;
};
