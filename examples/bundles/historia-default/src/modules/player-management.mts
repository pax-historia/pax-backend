import type { HistoriaPlayerRecord } from "../core/schema.mjs";
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
