export interface MapStateSummary {
  readonly entityCount: number;
  readonly flagCount: number;
}

export function emptyMapState(): MapStateSummary {
  return {
    entityCount: 0,
    flagCount: 0,
  };
}
