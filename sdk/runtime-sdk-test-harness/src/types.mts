import type {
  ApiInvokeResponse,
  BundleDefinition,
  ComputeBudgetSnapshot,
  ConnectedSessionSnapshot,
  MetricsEmitPayload,
  OnPlayerDisconnectPayload,
  OnPlayerMessagePayload,
  OnWakePayload,
  SubstrateContext,
  WsTarget,
} from "@pax-backend/runtime-sdk";

export interface HarnessSession extends ConnectedSessionSnapshot {
  readonly jwtClaims: Readonly<Record<string, unknown>>;
}

export interface HarnessApiFixture {
  readonly kind: string;
  readonly argsFingerprint: string;
  readonly response: ApiInvokeResponse;
}

export interface HarnessApiInvocation {
  readonly kind: string;
  readonly args: unknown;
  readonly idempotencyKey?: string;
  readonly triggeringSessionId: string | null;
  readonly connectedSessions: readonly ConnectedSessionSnapshot[];
  readonly response: ApiInvokeResponse;
}

export interface HarnessWsMessage {
  readonly target: WsTarget;
  readonly body: unknown;
}

export interface HarnessOptions {
  readonly seed?: string;
  readonly nowStartMs?: number;
  readonly allowedPlayers?: readonly string[];
  readonly sessions?: readonly HarnessSession[];
  readonly state?: unknown;
  readonly blobs?: Readonly<Record<string, Uint8Array>>;
  readonly apiFixtures?: readonly HarnessApiFixture[];
  readonly computeBudget?: ComputeBudgetSnapshot;
}

export interface RuntimeSdkHarness {
  readonly c: SubstrateContext;
  readonly logs: readonly Readonly<Record<string, unknown>>[];
  readonly metrics: readonly MetricsEmitPayload[];
  readonly wsMessages: readonly HarnessWsMessage[];
  readonly apiInvocations: readonly HarnessApiInvocation[];
  allowedPlayers(): readonly string[];
  connectedSessions(): readonly HarnessSession[];
  state(): unknown;
  blobs(): Readonly<Record<string, Uint8Array>>;
  connect(session: HarnessSession): Promise<void>;
  disconnect(sessionId: string, reason?: OnPlayerDisconnectPayload["reason"]): Promise<void>;
  wake(payload?: Partial<OnWakePayload>): Promise<void>;
  playerMessage(
    payload: Omit<OnPlayerMessagePayload, "seq"> & { readonly seq?: number },
  ): Promise<void>;
}

export interface HarnessBundleInput {
  readonly bundle: BundleDefinition;
  readonly bundleName?: string;
  readonly bundleCompatTag?: string;
  readonly runId?: string;
}
