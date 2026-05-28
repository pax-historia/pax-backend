import type { PlayerMessageHandler } from "../types.mjs";
import { readBodyType, readString } from "../util.mjs";

export const handleAdminMessage: PlayerMessageHandler = async (input) => {
  if (readBodyType(input.body) !== "admin.rename") return false;
  const title = readString(input.body["title"], "Untitled historia");
  await input.ctx.projectionSync({ op: "titleChanged", title });
  await input.c.ws.send("all", {
    type: "admin.renamed",
    seq: input.seq,
    title,
  });
  return true;
};
