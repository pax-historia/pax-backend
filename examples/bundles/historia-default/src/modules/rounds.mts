export function nextRound(currentRound: number): number {
  return Number.isInteger(currentRound) && currentRound > 0 ? currentRound + 1 : 1;
}
