import type { HistoriaGameContext } from "./context.mjs";
import { workflowTaskTracker } from "./ai/task-tracker.mjs";
import { entityOptions } from "./modules/player-management.mjs";

export function buildHydrationSnapshot(
  ctx: HistoriaGameContext,
  playerId: string,
): Readonly<Record<string, unknown>> {
  const player = ctx.loaded.blob.game.players[playerId];
  return {
    status: ctx.loaded.blob.game.status,
    title: ctx.loaded.blob.game.title ?? null,
    currentRound: ctx.loaded.blob.game.currentRound,
    player: player ?? null,
    players: Object.values(ctx.loaded.blob.game.players),
    entityOptions: entityOptions(ctx),
    pendingEvents: ctx.loaded.workingState.currentRoundDeltas,
    inFlightWorkflows: workflowTaskTracker.snapshot(),
    migratedFrom: ctx.loaded.migratedFrom ?? null,
  };
}
