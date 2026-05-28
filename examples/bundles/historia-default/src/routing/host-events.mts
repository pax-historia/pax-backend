import { participationRecordFromHostEvent } from "../modules/player-management.mjs";
import type { HostEventInput } from "../modules/types.mjs";
import { isRecord, readString } from "../modules/util.mjs";

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

  if (input.eventType === "workflowOverride") {
    const override = workflowOverrideFromPayload(input.payload);
    if (!override) return false;
    input.ctx.updateLoaded((loaded) => ({
      ...loaded,
      blob: {
        ...loaded.blob,
        updatedAt: input.ctx.now(),
        workflows: {
          ...loaded.blob.workflows,
          [override.module]: {
            code: override.code,
            entryPoints: override.entryPoints,
          },
        },
      },
    }));
    input.ctx.appendWorkingEvent("workflow.override.loaded", {
      module: override.module,
      entryPoints: override.entryPoints,
    });
    await input.c.ws.send("all", {
      type: "workflow.overrideLoaded",
      eventId: input.eventId,
      module: override.module,
    });
    return true;
  }

  return false;
}

function workflowOverrideFromPayload(
  payload: unknown,
): { readonly module: "chat" | "advisor" | "actions" | "jumpForward" | "moderation"; readonly code: string; readonly entryPoints: Readonly<Record<string, string>> } | undefined {
  if (!isRecord(payload) || !isRecord(payload["entryPoints"])) return undefined;
  const moduleName = readWorkflowModule(payload["module"]);
  const code = readString(payload["code"]);
  if (!moduleName || code.length === 0) return undefined;
  const entryPoints: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload["entryPoints"])) {
    if (typeof value === "string") entryPoints[key] = value;
  }
  return { module: moduleName, code, entryPoints };
}

function readWorkflowModule(
  value: unknown,
): "chat" | "advisor" | "actions" | "jumpForward" | "moderation" | undefined {
  return value === "chat" ||
    value === "advisor" ||
    value === "actions" ||
    value === "jumpForward" ||
    value === "moderation"
    ? value
    : undefined;
}
