import { canUseAdmin } from "../permissions.mjs";
import type { PlayerMessageHandler } from "../types.mjs";
import { readBodyType, readString } from "../util.mjs";

export const handleAdminMessage: PlayerMessageHandler = async (input) => {
  if (readBodyType(input.body) !== "admin.rename") return false;
  if (!canUseAdmin(input.jwtClaims)) {
    input.ctx.appendWorkingEvent("policy.refused", {
      playerId: input.playerId,
      seq: input.seq,
      reason: "adminOnly",
      surface: "admin",
    });
    await input.c.ws.send(input.playerId, {
      type: "historia.policyRefused",
      reason: "adminOnly",
      seq: input.seq,
    });
    return true;
  }
  const title = readString(input.body["title"], "Untitled historia");
  input.ctx.patchGame({ title });
  input.ctx.appendWorkingEvent("admin.renamed", {
    playerId: input.playerId,
    seq: input.seq,
    title,
  });
  await input.ctx.projectionSync({ op: "titleChanged", title });
  await input.c.ws.send("all", {
    type: "admin.renamed",
    seq: input.seq,
    title,
  });
  return true;
};
