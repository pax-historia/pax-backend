import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import WebSocket from "ws";

import { HistoryWriter } from "./driver-history.mjs";
import { NemesisRuntime } from "./nemesis-runtime.mjs";
import type {
  ApiKindWorkloadRegistration,
  ResolvedWorkloadFixture,
  ScenarioManifest,
  ScenarioRunnerInput,
  ScenarioRuntimeEnvironment,
  ScenarioWorkloadPhase,
  ScenarioWorkloadPlan,
  WorkloadFixtureKind,
  WsRefusalAttempt,
} from "./types.mjs";

const DEFAULT_CONTROL_PLANE_URL = "http://127.0.0.1:9070";
const DEFAULT_API_GATEWAY_URL = "http://127.0.0.1:9081";
const DEFAULT_ROUTER_URL = "http://127.0.0.1:9080";
const DEFAULT_PHASE_TIMEOUT_MS = 30_000;
const DEFAULT_JWT_SECRET = "local-dev-secret";

interface BundleManifest {
  readonly compatTagProduced: string;
  readonly compatTagsAccepted: readonly string[];
  readonly runtimeContractRequired: number;
}

interface BundleModule {
  readonly default?: {
    readonly manifest?: BundleManifest;
  };
}

interface PlacementResponse {
  readonly gameId: string;
  readonly shardId: string;
  readonly runtimeContractRequired: number;
  readonly runtimeContractsSupported: readonly [number, number];
  readonly shardUrl: string;
  readonly webSocketUrl: string;
  readonly placementToken: string;
  readonly expiresAt: number;
  readonly runId: string;
  readonly traceId: string;
  readonly bundleName: string;
  readonly serverTimings: Readonly<Record<string, number>>;
}

interface ReadyFrame {
  readonly type: "ready";
  readonly sessionId: string;
  readonly connectedAt?: number | string;
  readonly playerId?: string;
  readonly gameId?: string;
}

interface ScenarioSession {
  readonly gameId: string;
  readonly playerId: string;
  readonly sessionId: string;
  readonly shardUrl: string;
  readonly ws: WebSocket;
}

interface LiveExecutorContext {
  readonly input: ScenarioRunnerInput;
  readonly scenario: ScenarioManifest;
  readonly workload: ScenarioWorkloadPlan;
  readonly runtimeEnvironment: ScenarioRuntimeEnvironment;
  readonly repoRoot: string;
  readonly controlPlaneUrl: string;
  readonly apiGatewayUrl: string;
  readonly routerUrl: string;
  readonly phaseTimeoutMs: number;
  readonly startedAtMs: number;
  readonly sessions: ScenarioSession[];
  readonly historyWriter: HistoryWriter;
  readonly nemesisRuntime: NemesisRuntime;
}

export async function executeLiveWorkload(
  input: ScenarioRunnerInput,
  scenario: ScenarioManifest,
  workload: ScenarioWorkloadPlan,
  runtimeEnvironment: ScenarioRuntimeEnvironment,
): Promise<void> {
  if (input.backend !== "live") {
    throw new Error(`workload phase execution currently requires backend=live, got ${input.backend}`);
  }

  const controlPlaneUrl = trimTrailingSlash(
    input.controlPlaneUrl ?? process.env["PAX_CONTROL_URL"] ?? DEFAULT_CONTROL_PLANE_URL,
  );
  const apiGatewayUrl = normalizeApiGatewayBaseUrl(
    input.apiGatewayUrl ??
      process.env["PAX_SCENARIO_API_GATEWAY_URL"] ??
      process.env["PAX_API_GATEWAY_BASE_URL"] ??
      process.env["PAX_API_GATEWAY_URL"] ??
      DEFAULT_API_GATEWAY_URL,
  );
  const historyWriter = new HistoryWriter(input.historyPath);
  const startedAtMs = Date.now();
  const ctx: LiveExecutorContext = {
    input,
    scenario,
    workload,
    runtimeEnvironment,
    repoRoot: resolve(process.env["PAX_REPO_ROOT"] ?? process.cwd()),
    controlPlaneUrl,
    apiGatewayUrl,
    routerUrl: trimTrailingSlash(
      input.routerUrl ?? process.env["PAX_ROUTER_URL"] ?? DEFAULT_ROUTER_URL,
    ),
    phaseTimeoutMs:
      input.phaseTimeoutMs ??
      parsePositiveInt(process.env["PAX_SCENARIO_PHASE_TIMEOUT_MS"], DEFAULT_PHASE_TIMEOUT_MS),
    startedAtMs,
    sessions: [],
    historyWriter,
    nemesisRuntime: new NemesisRuntime(
      input.nemesisManifest ?? {
        nemesisId: input.nemesisId ?? scenario.defaultNemesis,
        description: "Nemesis manifest was not loaded.",
        actions: [{ type: "none" }],
      },
      controlPlaneUrl,
      historyWriter,
      input.runId,
    ),
  };

  try {
    ctx.nemesisRuntime.start();
    for (const [index, phase] of workload.phases.entries()) {
      ctx.nemesisRuntime.throwIfFailed();
      ctx.historyWriter.append("workload.phase.started", {
        scenarioId: scenario.scenarioId,
        runId: input.runId ?? null,
        phaseIndex: index,
        phaseType: phase.type,
      });
      const started = performance.now();
      await executePhase(ctx, phase);
      ctx.nemesisRuntime.throwIfFailed();
      ctx.historyWriter.append("workload.phase.completed", {
        scenarioId: scenario.scenarioId,
        runId: input.runId ?? null,
        phaseIndex: index,
        phaseType: phase.type,
        durationMs: Math.round(performance.now() - started),
      });
    }
  } catch (err) {
    ctx.historyWriter.append("workload.phase.failed", {
      scenarioId: scenario.scenarioId,
      runId: input.runId ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await ctx.nemesisRuntime.stop();
    await closeResidualSessions(ctx);
  }
}

async function executePhase(
  ctx: LiveExecutorContext,
  phase: ScenarioWorkloadPhase,
): Promise<void> {
  switch (phase.type) {
    case "seed-fixtures":
      await seedFixtures(ctx, phase.fixtureKinds);
      return;
    case "register-api-kinds":
      await registerApiKinds(ctx, phase.kinds);
      return;
    case "open-sessions":
      await openSessions(ctx, phase.sessionsPerGame, phase.rampMs);
      return;
    case "expect-ws-refusals":
      await expectWsRefusals(ctx, phase.attempts);
      return;
    case "send-json":
      await sendJson(
        ctx,
        phase.messagesPerSession,
        phase.intervalMs,
        phase.fanoutMs ?? 0,
        phase.body,
      );
      return;
    case "send-host-events":
      await sendHostEvents(
        ctx,
        phase.eventType,
        phase.payload,
        phase.wakeOnDelivery,
        phase.targetGameCount,
      );
      return;
    case "flip-bundles":
      await flipBundles(ctx, phase.newBundleName, phase.targetGameCount);
      return;
    case "expect-history-events":
      await expectHistoryEvents(ctx, phase.events, phase.minimumPerGame);
      return;
    case "wait":
      await sleep(phase.durationMs);
      return;
    case "await-nemesis":
      await ctx.nemesisRuntime.waitFor(phase.action, phase.minimumOccurrences, ctx.phaseTimeoutMs);
      return;
    case "sleep-wake":
      await sleepWake(ctx, phase.cycles, phase.idleMsBetweenCycles);
      return;
    case "evict-games":
      await evictGames(ctx, phase.targetGameCount, phase.reason ?? "scenarioEvict");
      return;
    case "close-sessions":
      await closeAllSessions(ctx, phase.reason);
      return;
    default:
      throw new Error(`unsupported workload phase ${phase.type}`);
  }
}

async function seedFixtures(
  ctx: LiveExecutorContext,
  fixtureKinds: readonly WorkloadFixtureKind[],
): Promise<void> {
  await ensureBundleUploaded(ctx, ctx.workload.bundleName);
  const selected = new Set(fixtureKinds);
  const allowedPlayers = selected.has("allowed-players")
    ? readStringArrayFixture(ctx, "allowed-players")
    : [];
  const initialState = selected.has("initial-state")
    ? readOptionalJsonFixture(ctx, "initial-state")
    : undefined;
  const initialBlob = selected.has("initial-blob")
    ? readOptionalJsonFixture(ctx, "initial-blob")
    : undefined;

  for (const gameId of scenarioGameIds(ctx.workload)) {
    await ensureGame(ctx, gameId, allowedPlayers, initialState, initialBlob);
  }
}

async function ensureBundleUploaded(
  ctx: LiveExecutorContext,
  bundleName: string,
): Promise<void> {
  const existing = await fetchJsonMaybe(
    `${ctx.controlPlaneUrl}/admin/bundles/${encodeURIComponent(bundleName)}`,
  );
  if (existing.status === 200) return;
  if (existing.status !== 404) {
    throw new Error(`bundle lookup failed for ${bundleName}: HTTP ${existing.status}`);
  }

  const sourcePath = join(ctx.repoRoot, "examples", "bundles", bundleName, "dist", "bundle.js");
  if (!existsSync(sourcePath)) {
    throw new Error(`compiled bundle source missing at ${sourcePath}; run pnpm build:bundles`);
  }
  const source = readFileSync(sourcePath, "utf8");
  const manifest = await loadBundleManifest(ctx.repoRoot, bundleName);
  await requestJson(`${ctx.controlPlaneUrl}/admin/bundles/${encodeURIComponent(bundleName)}`, {
    method: "POST",
    body: { manifest, source },
  });
}

async function loadBundleManifest(
  repoRoot: string,
  bundleName: string,
): Promise<BundleManifest> {
  const sourceModulePath = join(repoRoot, "examples", "bundles", bundleName, "src", "index.mts");
  const mod = (await import(pathToFileURL(sourceModulePath).href)) as BundleModule;
  const manifest = mod.default?.manifest;
  if (!manifest) throw new Error(`bundle ${bundleName} source did not export a manifest`);
  return manifest;
}

async function ensureGame(
  ctx: LiveExecutorContext,
  gameId: string,
  allowedPlayers: readonly string[],
  initialState: unknown,
  initialBlob: unknown,
): Promise<void> {
  const existing = await fetchJsonMaybe(
    `${ctx.controlPlaneUrl}/admin/games/${encodeURIComponent(gameId)}`,
  );
  if (existing.status === 200) {
    for (const playerId of allowedPlayers) {
      await addAllowedPlayer(ctx, gameId, playerId);
    }
    return;
  }
  if (existing.status !== 404) {
    throw new Error(`game lookup failed for ${gameId}: HTTP ${existing.status}`);
  }

  const body: Record<string, unknown> = {
    gameId,
    bundleName: ctx.workload.bundleName,
    allowedPlayers,
  };
  if (initialState !== undefined) body["initialState"] = initialState;
  if (initialBlob !== undefined) body["initialBlob"] = initialBlob;
  await requestJson(`${ctx.controlPlaneUrl}/admin/games`, { method: "POST", body });
}

async function addAllowedPlayer(
  ctx: LiveExecutorContext,
  gameId: string,
  playerId: string,
): Promise<void> {
  await requestJson(
    `${ctx.controlPlaneUrl}/admin/games/${encodeURIComponent(
      gameId,
    )}/allowed-players/${encodeURIComponent(playerId)}`,
    { method: "POST" },
  );
}

async function registerApiKinds(
  ctx: LiveExecutorContext,
  kinds: readonly ApiKindWorkloadRegistration[],
): Promise<void> {
  for (const kind of kinds) {
    await requestJson(`${ctx.controlPlaneUrl}/admin/api-kinds`, {
      method: "POST",
      body: {
        ...kind,
        url: kind.url
          .replaceAll("${controlPlaneUrl}", ctx.controlPlaneUrl)
          .replaceAll("${apiGatewayUrl}", ctx.apiGatewayUrl),
      },
    });
  }
}

async function openSessions(
  ctx: LiveExecutorContext,
  sessionsPerGame: number,
  rampMs: number,
): Promise<void> {
  await ensureBundleUploaded(ctx, ctx.workload.bundleName);
  const allowedPlayers = readStringArrayFixture(ctx, "allowed-players");
  if (allowedPlayers.length === 0) {
    throw new Error("open-sessions requires an allowed-players fixture with at least one player");
  }
  const gameIds = scenarioGameIds(ctx.workload);
  const planned = gameIds.flatMap((gameId) =>
    Array.from({ length: sessionsPerGame }, (_unused, index) => ({
      gameId,
      playerId: allowedPlayers[index % allowedPlayers.length] ?? allowedPlayers[0] ?? "player",
    })),
  );
  const intervalMs = planned.length > 1 ? rampMs / (planned.length - 1) : 0;

  for (const [index, session] of planned.entries()) {
    if (index > 0 && intervalMs > 0) await sleep(intervalMs);
    await ensureGame(ctx, session.gameId, allowedPlayers, undefined, undefined);
    ctx.sessions.push(await openOneSession(ctx, session.gameId, session.playerId));
  }
}

async function openOneSession(
  ctx: LiveExecutorContext,
  gameId: string,
  playerId: string,
): Promise<ScenarioSession> {
  const placement = await requestPlacement(ctx, gameId, playerId);
  const ws = new WebSocket(placement.webSocketUrl);
  const ready = await waitForReady(ws, ctx.phaseTimeoutMs, gameId, playerId);
  ws.on("close", (code: number, reason: Buffer) => {
    ctx.historyWriter.append("workload.session.closed", {
      scenarioId: ctx.scenario.scenarioId,
      runId: ctx.input.runId ?? null,
      gameId,
      playerId,
      sessionId: ready.sessionId,
      readyState: ws.readyState,
      code,
      reason: reason.toString("utf8"),
    });
  });
  ws.on("error", (err: Error) => {
    ctx.historyWriter.append("workload.session.error", {
      scenarioId: ctx.scenario.scenarioId,
      runId: ctx.input.runId ?? null,
      gameId,
      playerId,
      sessionId: ready.sessionId,
      message: err.message,
    });
  });
  return {
    gameId,
    playerId,
    sessionId: ready.sessionId,
    shardUrl: placement.shardUrl,
    ws,
  };
}

async function requestPlacement(
  ctx: LiveExecutorContext,
  gameId: string,
  playerId: string,
): Promise<PlacementResponse> {
  const placementUrl = `${ctx.routerUrl}/placement`;
  const traceId = randomBytes(16).toString("hex");
  const placementResult = await fetchJsonMaybe(placementUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      traceparent: `00-${traceId}-0000000000000001-01`,
    },
    body: JSON.stringify({
      gameId,
      playerId,
      runId: ctx.input.runId,
      traceId,
    }),
  });
  if (placementResult.status !== 200) {
    ctx.historyWriter.append("placement.rejected", {
      gameId,
      playerId,
      error: readErrorCode(placementResult.body) ?? `http_${placementResult.status}`,
      statusCode: placementResult.status,
      detail: placementResult.body,
    });
    throw new Error(`placement failed for ${gameId}/${playerId}: HTTP ${placementResult.status}`);
  }
  const placement = placementResult.body as PlacementResponse;
  ctx.historyWriter.append("placement.accepted", {
    gameId: placement.gameId,
    playerId,
    shardId: placement.shardId,
    placedShardId: placement.shardId,
    runId: placement.runId,
    traceId: placement.traceId,
    bundleName: placement.bundleName,
    runtimeContractRequired: placement.runtimeContractRequired,
    runtimeContractsSupported: placement.runtimeContractsSupported,
  });
  return placement;
}

function waitForReady(
  ws: WebSocket,
  timeoutMs: number,
  gameId: string,
  playerId: string,
): Promise<ReadyFrame> {
  return new Promise<ReadyFrame>((resolveReady, rejectReady) => {
    let settled = false;
    const timeout = setTimeout(() => {
      fail(new Error(`timeout waiting for ready frame for ${gameId}/${playerId}`));
    }, timeoutMs);

    function cleanup(): void {
      clearTimeout(timeout);
      ws.off("message", onMessage);
    }

    function fail(err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      rejectReady(err);
    }

    function succeed(frame: ReadyFrame): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolveReady(frame);
    }

    function onMessage(data: WebSocket.RawData): void {
      const parsed = parseWsFrame(data);
      if (isReadyFrame(parsed)) succeed(parsed);
    }

    ws.on("message", onMessage);
    ws.once("error", (err: Error) => fail(err));
    ws.once("close", (code: number, reason: Buffer) => {
      fail(
        new Error(
          `websocket closed before ready for ${gameId}/${playerId}: ${code} ${reason.toString(
            "utf8",
          )}`,
        ),
      );
    });
  });
}

async function sendJson(
  ctx: LiveExecutorContext,
  messagesPerSession: number,
  intervalMs: number,
  fanoutMs: number,
  body: Readonly<Record<string, unknown>>,
): Promise<void> {
  if (ctx.sessions.length === 0) {
    throw new Error("send-json requires at least one open session");
  }
  const perSessionDelayMs =
    fanoutMs > 0 && ctx.sessions.length > 1 ? fanoutMs / (ctx.sessions.length - 1) : 0;
  for (let messageIndex = 0; messageIndex < messagesPerSession; messageIndex += 1) {
    const waveStartedAt = performance.now();
    for (const [sessionIndex, session] of ctx.sessions.entries()) {
      if (session.ws.readyState !== WebSocket.OPEN) {
        throw new Error(
          `session ${session.sessionId} for ${session.gameId}/${session.playerId} is not open: readyState=${session.ws.readyState}`,
        );
      }
      session.ws.send(JSON.stringify(body));
      if (perSessionDelayMs > 0 && sessionIndex + 1 < ctx.sessions.length) {
        const targetElapsedMs = perSessionDelayMs * (sessionIndex + 1);
        await sleep(waveStartedAt + targetElapsedMs - performance.now());
      }
    }
    if (messageIndex + 1 < messagesPerSession && intervalMs > 0) {
      await sleep(Math.max(0, intervalMs - (performance.now() - waveStartedAt)));
    }
  }
}

async function expectWsRefusals(
  ctx: LiveExecutorContext,
  attempts: readonly WsRefusalAttempt[],
): Promise<void> {
  const gameIds = scenarioGameIds(ctx.workload);
  const allowedPlayers = readStringArrayFixture(ctx, "allowed-players");
  for (const attempt of attempts) {
    const placementGameId = gameIdAt(gameIds, attempt.placementGameIndex);
    const connectGameId = gameIdAt(gameIds, attempt.connectGameIndex ?? attempt.placementGameIndex);
    const playerId = attempt.playerId || allowedPlayers[0] || "player";
    await ensureGame(ctx, placementGameId, allowedPlayers, undefined, undefined);
    await ensureGame(ctx, connectGameId, allowedPlayers, undefined, undefined);
    const placement = await requestPlacement(ctx, placementGameId, playerId);
    const url = new URL(placement.webSocketUrl);
    if (connectGameId !== placementGameId) {
      url.searchParams.set("gameId", connectGameId);
    }
    switch (attempt.tokenMutation) {
      case undefined:
      case "none":
        break;
      case "tamper-signature":
        tamperPlacementToken(url);
        break;
      case "expire-token":
        expirePlacementToken(url);
        break;
    }
    const observed = await waitForRejectedWebSocket(url, connectGameId, ctx.phaseTimeoutMs);
    ctx.historyWriter.append("workload.ws-refusal.observed", {
      scenarioId: ctx.scenario.scenarioId,
      runId: ctx.input.runId ?? null,
      placementGameId,
      connectGameId,
      playerId,
      tokenMutation: attempt.tokenMutation ?? "none",
      expectedCode: attempt.expectedCode,
      expectedCodes: wsRefusalExpectedCodes(attempt),
      expectedReasonIncludes: attempt.expectedReasonIncludes ?? null,
      observedCode: observed.code,
      observedReason: observed.reason,
    });
    const expectedCodes = wsRefusalExpectedCodes(attempt);
    if (!expectedCodes.includes(observed.code)) {
      throw new Error(
        `expected WS refusal code ${expectedCodes.join(" or ")} for ${placementGameId}->${connectGameId}, got ${observed.code} (${observed.reason})`,
      );
    }
    if (
      attempt.expectedReasonIncludes &&
      !observed.reason.includes(attempt.expectedReasonIncludes)
    ) {
      throw new Error(
        `expected WS refusal reason to include ${attempt.expectedReasonIncludes}, got ${observed.reason}`,
      );
    }
  }
}

function wsRefusalExpectedCodes(attempt: WsRefusalAttempt): readonly number[] {
  return attempt.expectedCodes ?? (attempt.expectedCode === undefined ? [] : [attempt.expectedCode]);
}

function gameIdAt(gameIds: readonly string[], oneBasedIndex: number): string {
  const gameId = gameIds[oneBasedIndex - 1];
  if (!gameId) {
    throw new Error(`workload does not define game index ${oneBasedIndex}`);
  }
  return gameId;
}

function tamperPlacementToken(url: URL): void {
  const key = url.searchParams.has("placementToken") ? "placementToken" : "token";
  const token = url.searchParams.get(key);
  if (!token) throw new Error("placement URL missing placement token");
  const last = token[token.length - 1] ?? "a";
  const replacement = last === "a" ? "b" : "a";
  url.searchParams.set(key, `${token.slice(0, -1)}${replacement}`);
}

function expirePlacementToken(url: URL): void {
  const key = url.searchParams.has("placementToken") ? "placementToken" : "token";
  const token = url.searchParams.get(key);
  if (!token) throw new Error("placement URL missing placement token");
  const [headerPart, payloadPart] = token.split(".");
  if (!headerPart || !payloadPart) throw new Error("placement token is not a JWT");
  const header = decodeJwtPart(headerPart);
  const payload = decodeJwtPart(payloadPart);
  const exp = Math.floor(Date.now() / 1000) - 60;
  url.searchParams.set(
    key,
    signJwt(header, {
      ...payload,
      iat: exp - 60,
      exp,
    }),
  );
}

function decodeJwtPart(part: string): Record<string, unknown> {
  const decoded = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("JWT part did not decode to an object");
  }
  return decoded as Record<string, unknown>;
}

function signJwt(
  header: Readonly<Record<string, unknown>>,
  payload: Readonly<Record<string, unknown>>,
): string {
  const encodedHeader = encodeJwtPart(header);
  const encodedPayload = encodeJwtPart(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = createHmac(
    "sha256",
    process.env["PAX_JWT_SECRET"] ?? DEFAULT_JWT_SECRET,
  )
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

function encodeJwtPart(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function waitForRejectedWebSocket(
  url: URL,
  _gameId: string,
  timeoutMs: number,
): Promise<{ readonly code: number; readonly reason: string }> {
  return new Promise((resolveClose, rejectClose) => {
    const ws = new WebSocket(url.toString());
    let lastError: string | undefined;
    const timeout = setTimeout(() => {
      ws.terminate();
      rejectClose(new Error(`timeout waiting for rejected websocket: ${lastError ?? url.toString()}`));
    }, timeoutMs);
    ws.once("error", (err: Error) => {
      lastError = err.message;
    });
    ws.once("close", (code: number, reason: Buffer) => {
      clearTimeout(timeout);
      resolveClose({ code, reason: reason.toString("utf8") });
    });
  });
}

async function sendHostEvents(
  ctx: LiveExecutorContext,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
  wakeOnDelivery: boolean,
  targetGameCount: number,
): Promise<void> {
  for (const gameId of targetGameIds(ctx.workload, targetGameCount)) {
    const response = await requestJson<{ readonly eventId?: string; readonly status?: string }>(
      `${ctx.controlPlaneUrl}/admin/games/${encodeURIComponent(gameId)}/host-event`,
      {
        method: "POST",
        body: { eventType, payload, wakeOnDelivery },
      },
    );
    ctx.historyWriter.append("workload.host-event.sent", {
      scenarioId: ctx.scenario.scenarioId,
      runId: ctx.input.runId ?? null,
      gameId,
      eventType,
      wakeOnDelivery,
      eventId: response.eventId ?? null,
      status: response.status ?? null,
    });
  }
}

async function flipBundles(
  ctx: LiveExecutorContext,
  newBundleName: string,
  targetGameCount: number,
): Promise<void> {
  await ensureBundleUploaded(ctx, newBundleName);
  for (const gameId of targetGameIds(ctx.workload, targetGameCount)) {
    await requestJson(`${ctx.controlPlaneUrl}/admin/games/${encodeURIComponent(gameId)}/bundle`, {
      method: "POST",
      body: { newBundleName },
    });
    ctx.historyWriter.append("workload.bundle-flip.sent", {
      scenarioId: ctx.scenario.scenarioId,
      runId: ctx.input.runId ?? null,
      gameId,
      newBundleName,
    });
  }
}

async function expectHistoryEvents(
  ctx: LiveExecutorContext,
  events: readonly string[],
  minimumPerGame: number,
): Promise<void> {
  const waitMode =
    process.env["PAX_SCENARIO_EXPECT_HISTORY_MODE"] ??
    (process.env["PAX_SCENARIO_HISTORY_PROFILE"] === "scale" ? "delay" : "control-plane");
  if (waitMode === "delay") {
    const delayMs = parsePositiveInt(
      process.env["PAX_SCENARIO_EXPECT_HISTORY_DELAY_MS"],
      3_000,
    );
    ctx.historyWriter.append("workload.history-wait.delayed", {
      scenarioId: ctx.scenario.scenarioId,
      runId: ctx.input.runId ?? null,
      expectedEvents: events,
      minimumPerGame,
      delayMs,
    });
    await sleep(delayMs);
    return;
  }
  if (waitMode !== "control-plane") {
    throw new Error(
      `invalid PAX_SCENARIO_EXPECT_HISTORY_MODE=${waitMode}; expected control-plane or delay`,
    );
  }

  const gameIds = scenarioGameIds(ctx.workload);
  const deadline = performance.now() + ctx.phaseTimeoutMs;
  const missing = new Map<string, number>();
  while (performance.now() <= deadline) {
    missing.clear();
    for (const gameId of gameIds) {
      for (const event of events) {
        const count = await countHistoryEvents(ctx, gameId, event);
        if (count < minimumPerGame) {
          missing.set(`${gameId}:${event}`, minimumPerGame - count);
        }
      }
    }
    if (missing.size === 0) return;
    await sleep(250);
  }

  throw new Error(
    `timed out waiting for history events: ${Array.from(missing.entries())
      .map(([key, remaining]) => `${key} missing ${remaining}`)
      .join(", ")}`,
  );
}

async function countHistoryEvents(
  ctx: LiveExecutorContext,
  gameId: string,
  event: string,
): Promise<number> {
  const url = new URL(`${ctx.controlPlaneUrl}/admin/history`);
  url.searchParams.set("gameId", gameId);
  url.searchParams.set("event", event);
  url.searchParams.set("from", new Date(ctx.startedAtMs - 1_000).toISOString());
  url.searchParams.set("limit", "1000");
  const body = await requestJson<{ readonly events?: readonly unknown[] }>(url.toString());
  return Array.isArray(body.events) ? body.events.length : 0;
}

async function sleepWake(
  ctx: LiveExecutorContext,
  cycles: number,
  idleMsBetweenCycles: number,
): Promise<void> {
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    const sessionPlan = ctx.sessions.map((session) => ({
      gameId: session.gameId,
      playerId: session.playerId,
    }));
    if (sessionPlan.length === 0) {
      throw new Error("sleep-wake requires at least one open session");
    }
    ctx.historyWriter.append("workload.sleep-wake.cycle.started", {
      scenarioId: ctx.scenario.scenarioId,
      runId: ctx.input.runId ?? null,
      cycle,
      sessions: sessionPlan.length,
      idleMsBetweenCycles,
    });
    await closeAllSessions(ctx, `sleepWakeCycle${cycle}`);
    await sleep(idleMsBetweenCycles);
    for (const session of sessionPlan) {
      ctx.sessions.push(await openOneSession(ctx, session.gameId, session.playerId));
    }
    ctx.historyWriter.append("workload.sleep-wake.cycle.completed", {
      scenarioId: ctx.scenario.scenarioId,
      runId: ctx.input.runId ?? null,
      cycle,
      sessions: ctx.sessions.length,
    });
  }
}

async function evictGames(
  ctx: LiveExecutorContext,
  targetGameCount: number,
  reason: string,
): Promise<void> {
  const targets = new Set(targetGameIds(ctx.workload, targetGameCount));
  const sessions = ctx.sessions.splice(0);
  const retained: ScenarioSession[] = [];
  const closing: Promise<void>[] = [];
  const shardUrlByGame = new Map<string, string>();

  for (const session of sessions) {
    if (!targets.has(session.gameId)) {
      retained.push(session);
      continue;
    }
    shardUrlByGame.set(session.gameId, session.shardUrl);
    closing.push(waitForSessionClosed(session));
  }
  ctx.sessions.push(...retained);

  for (const gameId of targets) {
    const shardUrl = shardUrlByGame.get(gameId) ?? await firstShardUrl(ctx);
    await requestJson(`${trimTrailingSlash(shardUrl)}/admin/games/${encodeURIComponent(gameId)}/evict`, {
      method: "POST",
    });
    ctx.historyWriter.append("workload.game.evicted", {
      scenarioId: ctx.scenario.scenarioId,
      runId: ctx.input.runId ?? null,
      gameId,
      reason,
      shardUrl,
    });
  }

  await Promise.all(closing);
}

async function waitForSessionClosed(session: ScenarioSession): Promise<void> {
  if (
    session.ws.readyState === WebSocket.CLOSED ||
    session.ws.readyState === WebSocket.CLOSING
  ) {
    return;
  }
  await new Promise<void>((resolveClose) => {
    const timeout = setTimeout(resolveClose, 2_000);
    session.ws.once("close", () => {
      clearTimeout(timeout);
      resolveClose();
    });
  });
}

async function firstShardUrl(ctx: LiveExecutorContext): Promise<string> {
  const body = await requestJson<{ readonly shards?: readonly { readonly url?: string }[] }>(
    `${ctx.controlPlaneUrl}/admin/shards`,
  );
  const url = body.shards?.find((shard) => typeof shard.url === "string")?.url;
  if (!url) throw new Error("evict-games could not find a shard URL");
  return url;
}

async function closeAllSessions(ctx: LiveExecutorContext, reason: string): Promise<void> {
  const sessions = ctx.sessions.splice(0);
  await Promise.all(
    sessions.map(
      (session) =>
        new Promise<void>((resolveClose) => {
          if (
            session.ws.readyState === WebSocket.CLOSED ||
            session.ws.readyState === WebSocket.CLOSING
          ) {
            resolveClose();
            return;
          }
          const timeout = setTimeout(resolveClose, 2_000);
          session.ws.once("close", () => {
            clearTimeout(timeout);
            resolveClose();
          });
          session.ws.close(1000, reason);
        }),
    ),
  );
}

async function closeResidualSessions(ctx: LiveExecutorContext): Promise<void> {
  if (ctx.sessions.length === 0) return;
  await closeAllSessions(ctx, "scenarioRunnerAbort");
}

function scenarioGameIds(workload: ScenarioWorkloadPlan): readonly string[] {
  return Array.from(
    { length: workload.maxGames },
    (_unused, index) => `${workload.gameIdPrefix}-${index + 1}`,
  );
}

function targetGameIds(
  workload: ScenarioWorkloadPlan,
  targetGameCount: number,
): readonly string[] {
  if (!Number.isInteger(targetGameCount) || targetGameCount < 1) {
    throw new Error(`targetGameCount must be a positive integer, got ${targetGameCount}`);
  }
  if (targetGameCount > workload.maxGames) {
    throw new Error(
      `targetGameCount ${targetGameCount} exceeds workload maxGames ${workload.maxGames}`,
    );
  }
  return scenarioGameIds(workload).slice(0, targetGameCount);
}

function readStringArrayFixture(
  ctx: LiveExecutorContext,
  kind: WorkloadFixtureKind,
): readonly string[] {
  const value = readRequiredJsonFixture(ctx, kind);
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${kind} fixture must be a JSON string array`);
  }
  return value;
}

function readOptionalJsonFixture(
  ctx: LiveExecutorContext,
  kind: WorkloadFixtureKind,
): unknown {
  const fixture = findFixture(ctx.runtimeEnvironment.fixtures, kind);
  return fixture ? readJsonFile(fixture.absolutePath) : undefined;
}

function readRequiredJsonFixture(
  ctx: LiveExecutorContext,
  kind: WorkloadFixtureKind,
): unknown {
  const fixture = findFixture(ctx.runtimeEnvironment.fixtures, kind);
  if (!fixture) throw new Error(`missing ${kind} fixture`);
  return readJsonFile(fixture.absolutePath);
}

function findFixture(
  fixtures: readonly ResolvedWorkloadFixture[],
  kind: WorkloadFixtureKind,
): ResolvedWorkloadFixture | undefined {
  return fixtures.find((fixture) => fixture.kind === kind);
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

async function requestJson<T = unknown>(
  url: string,
  options: { readonly method?: string; readonly body?: unknown } = {},
): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers:
      options.body === undefined
        ? undefined
        : {
            "content-type": "application/json",
          },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await readResponseBody(response);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${JSON.stringify(body)}`);
  }
  return body as T;
}

async function fetchJsonMaybe(
  url: string,
  init?: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: await readResponseBody(response),
  };
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function readErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const error = (body as Record<string, unknown>)["error"];
  return typeof error === "string" ? error : undefined;
}

function parseWsFrame(data: WebSocket.RawData): unknown {
  try {
    return JSON.parse(data.toString()) as unknown;
  } catch {
    return data.toString();
  }
}

function isReadyFrame(value: unknown): value is ReadyFrame {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { readonly type?: unknown }).type === "ready" &&
    typeof (value as { readonly sessionId?: unknown }).sessionId === "string"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)));
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizeApiGatewayBaseUrl(value: string): string {
  const trimmed = trimTrailingSlash(value);
  return trimmed.endsWith("/invoke") ? trimmed.slice(0, -"/invoke".length) : trimmed;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
