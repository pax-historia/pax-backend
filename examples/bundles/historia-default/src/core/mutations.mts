import type { LoadedHistoriaState } from "./persistence.mjs";
import type {
  HistoriaBlobV5,
  HistoriaGameStatus,
  HistoriaPlayerRecord,
  WorkingEvent,
} from "./schema.mjs";

export function withWorkingEvent(
  loaded: LoadedHistoriaState,
  type: string,
  payload: unknown,
  now: number,
): LoadedHistoriaState {
  const event: WorkingEvent = {
    id: `${type}:${now}:${loaded.workingState.currentRoundDeltas.length + 1}`,
    type,
    payload,
    at: now,
  };
  return {
    ...loaded,
    workingState: {
      ...loaded.workingState,
      updatedAt: now,
      currentRoundDeltas: [...loaded.workingState.currentRoundDeltas, event].slice(-200),
    },
  };
}

export function withPlayerRecord(
  loaded: LoadedHistoriaState,
  player: HistoriaPlayerRecord,
  now: number,
): LoadedHistoriaState {
  return withBlob(loaded, {
    ...loaded.blob,
    updatedAt: now,
    game: {
      ...loaded.blob.game,
      players: {
        ...loaded.blob.game.players,
        [player.playerId]: player,
      },
    },
  });
}

export function withGamePatch(
  loaded: LoadedHistoriaState,
  patch: {
    readonly status?: HistoriaGameStatus;
    readonly title?: string;
    readonly currentRound?: number;
  },
  now: number,
): LoadedHistoriaState {
  return withBlob(loaded, {
    ...loaded.blob,
    updatedAt: now,
    game: {
      ...loaded.blob.game,
      ...patch,
    },
  });
}

export function withBlob(loaded: LoadedHistoriaState, blob: HistoriaBlobV5): LoadedHistoriaState {
  return {
    ...loaded,
    blob,
  };
}
