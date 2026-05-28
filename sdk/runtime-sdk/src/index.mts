// @pax-backend/runtime-sdk — the typed creator surface.
//
// Creator bundles import the types and the defineBundle validator from this
// package. At runtime inside the isolated-vm child, the substrate injects
// the typed context object `c` as a set of ivm bridges and calls into the
// bundle's exported handlers. The SDK is the seam where creator code and
// the substrate's contract meet.

import type {
  ApiInvokeResponse,
  BundleManifest,
  ComputeBudgetSnapshot,
  ConnectedSessionSnapshot,
  MetricsEmitPayload,
  OnCapacityWarningPayload,
  OnPlayerConnectPayload,
  OnPlayerDisconnectPayload,
  OnPlayerMessagePayload,
  OnSleepPayload,
  OnWakePayload,
  StorageWriteResponse,
  WsTarget,
} from "@pax-backend/ipc-protocol";

export type {
  ApiInvokeResponse,
  BundleManifest,
  ComputeBudgetSnapshot,
  ConnectedSessionSnapshot,
  MetricsEmitPayload,
  StorageWriteResponse,
} from "@pax-backend/ipc-protocol";

// ----- The typed substrate context (`c`) ---------------------------------

export interface SubstrateContext {
  /** Deterministic substrate PRNG for test-mode repeatability; returns [0, 1). */
  rng(): number;
  /** Deterministic substrate monotonic clock for creator code. */
  now(): number;
  readonly ws: {
    /**
     * Send a JSON-safe body to one or more players on this game. Use the
     * literal `"all"` to broadcast to every connected player.
     */
    send(target: WsTarget, body: unknown): void;
  };
  readonly log: {
    /** Structured log; routed to history with bundle metadata attached. */
    emit(payload: Readonly<Record<string, unknown>>): void;
  };
  readonly metrics: {
    /** Numeric metric; counter, gauge, or histogram. */
    emit(payload: MetricsEmitPayload): void;
  };
  readonly lifecycle: {
    /** Voluntary shutdown signal. The substrate may sleep this game soon. */
    requestSleep(): void;
  };
  readonly api: {
    /**
     * Invoke an operator-registered URL service kind. Args and result are
     * opaque to the substrate; URL services own application semantics.
     */
    invoke(
      kind: string,
      args: unknown,
      options?: { readonly idempotencyKey?: string },
    ): Promise<ApiInvokeResponse>;
  };
  readonly players: {
    /** Read the substrate-owned per-game whitelist. */
    allowed(): Promise<readonly string[]>;
    /** Read currently connected sessions for this game. */
    connected(): Promise<readonly ConnectedSessionSnapshot[]>;
  };
  readonly compute: {
    /** Read current compute-plane usage and configured limits. */
    budget(): Promise<ComputeBudgetSnapshot>;
  };
  readonly state: {
    /** Read the small, fast per-game state tier. */
    read(): Promise<unknown | undefined>;
    /** Replace the small state tier value. Fails with sizeExceeded over 128 KB. */
    write(value: unknown): Promise<StorageWriteResponse>;
    /** Force-flush pending state writes. Redis-backed local mode is already immediate. */
    flush(): Promise<StorageWriteResponse>;
  };
  readonly blob: {
    /** Read the large durable blob tier. */
    read(): Promise<unknown | undefined>;
    /** Replace the blob tier value. */
    write(value: unknown): Promise<StorageWriteResponse>;
  };
}

// ----- Bundle handler signatures -----------------------------------------

export type Handler<P> = (c: SubstrateContext, payload: P) => void | Promise<void>;

export interface BundleHandlers {
  onWake?: Handler<OnWakePayload>;
  onSleep?: Handler<OnSleepPayload>;
  onPlayerConnect?: Handler<OnPlayerConnectPayload>;
  onPlayerDisconnect?: Handler<OnPlayerDisconnectPayload>;
  onPlayerMessage?: Handler<OnPlayerMessagePayload>;
  onCapacityWarning?: Handler<OnCapacityWarningPayload>;
}

export interface BundleDefinition extends BundleHandlers {
  readonly manifest: BundleManifest;
}

// ----- defineBundle (the validator) --------------------------------------

/**
 * Validates the manifest in-band (matches the upload-time check the admin
 * endpoint will do at POST /admin/bundles/:name) and returns the
 * definition. Throws if the manifest is internally inconsistent.
 *
 * Same validator runs:
 *   - Host-side when the parent extracts a bundle's manifest before publish
 *   - In-isolate at bundle eval (every cold-start)
 *   - At publish time on the admin upload (M2+)
 */
export function defineBundle<T extends BundleDefinition>(def: T): T {
  if (!def || typeof def !== "object") {
    throw new Error("defineBundle: definition must be an object");
  }
  const m = def.manifest;
  if (!m || typeof m !== "object") {
    throw new Error("defineBundle: manifest is required");
  }
  if (typeof m.compatTagProduced !== "string" || m.compatTagProduced.length === 0) {
    throw new Error("defineBundle: manifest.compatTagProduced must be a non-empty string");
  }
  if (!Array.isArray(m.compatTagsAccepted) || m.compatTagsAccepted.length === 0) {
    throw new Error("defineBundle: manifest.compatTagsAccepted must be a non-empty array");
  }
  if (!m.compatTagsAccepted.includes(m.compatTagProduced)) {
    throw new Error(
      `defineBundle: compatTagProduced (${m.compatTagProduced}) must appear in compatTagsAccepted (${JSON.stringify(
        m.compatTagsAccepted,
      )}) — a bundle must be able to read what it writes`,
    );
  }
  if (!Number.isInteger(m.runtimeContractRequired) || m.runtimeContractRequired < 1) {
    throw new Error("defineBundle: manifest.runtimeContractRequired must be a positive integer");
  }
  return def;
}
