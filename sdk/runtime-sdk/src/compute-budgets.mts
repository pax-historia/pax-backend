import type { ComputeBudgetSnapshot } from "@pax-backend/ipc-protocol";

export type { ComputeBudgetSnapshot } from "@pax-backend/ipc-protocol";

export interface ComputeBudgetChannel {
  /** Read current compute-plane usage and configured limits. */
  budget(): Promise<ComputeBudgetSnapshot>;
}
