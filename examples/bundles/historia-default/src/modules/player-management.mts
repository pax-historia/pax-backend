import type { HistoriaPlayerRecord } from "../core/schema.mjs";
import type { HistoriaGameContext } from "../context.mjs";
import { isRecord, readBoolean, readNumber, readString } from "./util.mjs";

export function participationRecordFromHostEvent(
  payload: unknown,
  fallbackAt: number,
): HistoriaPlayerRecord | undefined {
  if (!isRecord(payload)) return undefined;
  const playerId = readString(payload["playerId"]);
  if (playerId.length === 0) return undefined;
  return {
    playerId,
    participant: readBoolean(payload["participant"]),
    entityId: readString(payload["entityId"]) || undefined,
    lastChangedAt: readNumber(payload["changedAt"], fallbackAt),
  };
}

export function isParticipant(ctx: HistoriaGameContext, playerId: string): boolean {
  return ctx.loaded.blob.game.players[playerId]?.participant === true;
}

export function entityOptions(ctx: HistoriaGameContext): readonly { entityId: string; available: boolean }[] {
  const claimed = new Set(
    Object.values(ctx.loaded.blob.game.players).flatMap((player) =>
      player.entityId && player.participant ? [player.entityId] : [],
    ),
  );
  return ["entity-1", "entity-2", "entity-3", "entity-4"].map((entityId) => ({
    entityId,
    available: !claimed.has(entityId),
  }));
}
