import type {
  ApiInvokeResponse,
  ComputeBudgetSnapshot,
  ConnectedSessionSnapshot,
  MetricsEmitPayload,
  OnPlayerDisconnectPayload,
  OnPlayerMessagePayload,
  OnWakePayload,
  StorageWriteResponse,
  SubstrateContext,
} from "@pax-backend/runtime-sdk";

import { fingerprintArgs } from "./fingerprint.mjs";
import { makeSeededRng } from "./prng.mjs";
import type {
  HarnessApiFixture,
  HarnessApiInvocation,
  HarnessBundleInput,
  HarnessOptions,
  HarnessSession,
  HarnessWsMessage,
  RuntimeSdkHarness,
} from "./types.mjs";

const DEFAULT_COMPUTE_BUDGET: ComputeBudgetSnapshot = {
  "cpu-ms-per-tick": { currentUsage: 0, limit: 1_000 },
  "memory-bytes": { currentUsage: 0, limit: 134_217_728 },
  "bandwidth-bytes-per-sec": { currentUsage: 0, limit: 65_536, windowMs: 1_000 },
  "ws-messages-per-sec": { currentUsage: 0, limit: 50, windowMs: 1_000 },
  "state-bytes": { currentUsage: 0, limit: 131_072 },
  "blob-bytes": { currentUsage: 0, limit: 10_485_760 },
  "api-invocations-per-min": { currentUsage: 0, limit: 60, windowMs: 60_000 },
};

export function createRuntimeSdkHarness(
  input: HarnessBundleInput,
  options: HarnessOptions = {},
): RuntimeSdkHarness {
  let stateValue = options.state;
  let blobValue = options.blob;
  let nowMs = options.nowStartMs ?? 1_700_000_000_000;
  let nextSeq = 0;
  let currentTriggeringSessionId: string | null = null;
  const rng = makeSeededRng(options.seed ?? input.runId ?? "pax-harness");
  const allowed = new Set(options.allowedPlayers ?? []);
  const sessions = new Map<string, HarnessSession>(
    (options.sessions ?? []).map((session) => [session.sessionId, session]),
  );
  const fixtures = fixtureMap(options.apiFixtures ?? []);
  const logs: Readonly<Record<string, unknown>>[] = [];
  const metrics: MetricsEmitPayload[] = [];
  const wsMessages: HarnessWsMessage[] = [];
  const apiInvocations: HarnessApiInvocation[] = [];

  const c: SubstrateContext = {
    rng,
    now: () => {
      nowMs += 1;
      return nowMs;
    },
    ws: {
      send: async (target, body) => {
        wsMessages.push({ target, body });
        const raw = JSON.stringify(body);
        return {
          ok: true,
          sent: 1,
          bytes: typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : 0,
        };
      },
    },
    log: {
      emit: (payload) => {
        logs.push(payload);
      },
    },
    metrics: {
      emit: (payload) => {
        metrics.push(payload);
      },
    },
    lifecycle: {
      requestSleep: () => {
        logs.push({ event: "harness.lifecycle.requestSleep" });
      },
    },
    api: {
      invoke: async (kind, args, invokeOptions = {}) => {
        const response = responseForFixture(fixtures, kind, args);
        apiInvocations.push({
          kind,
          args,
          idempotencyKey: invokeOptions.idempotencyKey,
          triggeringSessionId: currentTriggeringSessionId,
          connectedSessions: connectedSessionsSnapshot(sessions),
          response,
        });
        return response;
      },
    },
    players: {
      allowed: async () => Array.from(allowed).sort(),
      connected: async () => connectedSessionsSnapshot(sessions),
    },
    compute: {
      budget: async () => options.computeBudget ?? DEFAULT_COMPUTE_BUDGET,
    },
    state: {
      read: async () => stateValue,
      write: async (value) => {
        stateValue = value;
        return ok();
      },
      flush: async () => ok(),
    },
    blob: {
      read: async () => blobValue,
      write: async (value) => {
        blobValue = value;
        return ok();
      },
    },
  };

  return {
    c,
    logs,
    metrics,
    wsMessages,
    apiInvocations,
    allowedPlayers: () => Array.from(allowed).sort(),
    connectedSessions: () => Array.from(sessions.values()),
    state: () => stateValue,
    blob: () => blobValue,
    connect: async (session) => {
      allowed.add(session.playerId);
      sessions.set(session.sessionId, session);
      await input.bundle.onPlayerConnect?.(c, {
        playerId: session.playerId,
        sessionId: session.sessionId,
        jwtClaims: session.jwtClaims,
        connectedAt: session.connectedAt,
      });
    },
    disconnect: async (sessionId, reason = "left") => {
      const session = sessions.get(sessionId);
      if (!session) return;
      sessions.delete(sessionId);
      const payload: OnPlayerDisconnectPayload = {
        playerId: session.playerId,
        sessionId,
        reason,
      };
      await input.bundle.onPlayerDisconnect?.(c, payload);
    },
    wake: async (payload = {}) => {
      await input.bundle.onWake?.(c, {
        reason: "cold-start",
        runId: input.runId ?? "harness-run",
        bundleName: input.bundleName ?? "harness-bundle",
        bundleCompatTag:
          input.bundleCompatTag ?? input.bundle.manifest.compatTagProduced,
        state: stateValue,
        blob: blobValue,
        ...payload,
      } satisfies OnWakePayload);
    },
    playerMessage: async (payload) => {
      const seq = payload.seq ?? nextSeq + 1;
      nextSeq = seq;
      currentTriggeringSessionId = payload.sessionId;
      try {
        await input.bundle.onPlayerMessage?.(c, {
          ...payload,
          seq,
        } satisfies OnPlayerMessagePayload);
      } finally {
        currentTriggeringSessionId = null;
      }
    },
  };
}

function ok(): StorageWriteResponse {
  return { ok: true };
}

function fixtureMap(
  fixtures: readonly HarnessApiFixture[],
): ReadonlyMap<string, ApiInvokeResponse> {
  return new Map(
    fixtures.map((fixture) => [
      `${fixture.kind}:${fixture.argsFingerprint}`,
      fixture.response,
    ]),
  );
}

function responseForFixture(
  fixtures: ReadonlyMap<string, ApiInvokeResponse>,
  kind: string,
  args: unknown,
): ApiInvokeResponse {
  const response = fixtures.get(`${kind}:${fingerprintArgs(args)}`);
  return (
    response ?? {
      ok: false,
      error: "replayCoverageGap",
      detail: { kind, argsFingerprint: fingerprintArgs(args) },
    }
  );
}

function connectedSessionsSnapshot(
  sessions: ReadonlyMap<string, HarnessSession>,
): readonly ConnectedSessionSnapshot[] {
  return Array.from(sessions.values())
    .map(({ sessionId, playerId, connectedAt }) => ({ sessionId, playerId, connectedAt }))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}
