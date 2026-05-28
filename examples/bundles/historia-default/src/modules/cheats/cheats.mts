import type { PlayerMessageHandler } from "../types.mjs";
import { readBodyType, readString } from "../util.mjs";

export const handleCheatsMessage: PlayerMessageHandler = async (input) => {
  if (readBodyType(input.body) !== "cheats.reason") return false;
  await input.c.ws.send("all", {
    type: "cheats.reasonBroadcast",
    seq: input.seq,
    playerId: input.playerId,
    reason: readString(input.body["reason"], "No reason supplied."),
  });
  return true;
};
