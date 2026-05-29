import { performance } from "node:perf_hooks";

import WebSocket, { type RawData } from "ws";

const DEMO_URL = trimSlash(process.env["PAX_DEMO_URL"] ?? "http://127.0.0.1:8088");
const CLIENTS = parsePositiveInt(process.env["PAX_FANOUT_CLIENTS"], 25);
const DURATION_MS = parsePositiveInt(process.env["PAX_FANOUT_DURATION_MS"], 30_000);
const RAMP_MS = parseNonNegativeInt(process.env["PAX_FANOUT_RAMP_MS"], 5_000);
const EXPECTED_TICK_MS = parsePositiveInt(process.env["PAX_FANOUT_EXPECTED_TICK_MS"], 33);

interface JoinResponse {
  readonly ok: boolean;
  readonly gameId: string;
  readonly playerId: string;
  readonly webSocketUrl: string;
}

interface ClientStats {
  readonly index: number;
  readonly playerId: string;
  readonly sessionId?: string;
  readonly openedAt: number;
  closedAt?: number;
  firstStateAt?: number;
  lastStateAt?: number;
  frames: number;
  bytes: number;
  tickGaps: number;
  malformed: number;
  readonly interFrameGaps: number[];
}

interface ConnectedClient {
  readonly stats: ClientStats;
  readonly ws: WebSocket;
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const clients: ConnectedClient[] = [];
  console.log("[fanout] config", { DEMO_URL, CLIENTS, DURATION_MS, RAMP_MS, EXPECTED_TICK_MS });

  for (let index = 0; index < CLIENTS; index += 1) {
    clients.push(await connectClient(index));
    const delay = CLIENTS > 1 ? RAMP_MS / (CLIENTS - 1) : 0;
    if (delay > 0) await sleep(delay);
  }

  await sleep(DURATION_MS);
  for (const client of clients) client.ws.close(1000, "fanout done");
  await sleep(500);

  const report = buildReport(clients.map((client) => client.stats), performance.now() - startedAt);
  console.log(JSON.stringify(report, null, 2));
}

async function connectClient(index: number): Promise<ConnectedClient> {
  const joined = await join(index);
  const openedAt = performance.now();
  const stats: ClientStats = {
    index,
    playerId: joined.playerId,
    openedAt,
    frames: 0,
    bytes: 0,
    tickGaps: 0,
    malformed: 0,
    interFrameGaps: [],
  };
  const ws = new WebSocket(joined.webSocketUrl);
  let lastTickSeq: number | undefined;

  ws.on("message", (data) => {
    const receivedAt = performance.now();
    const text = rawDataToString(data);
    stats.bytes += Buffer.byteLength(text, "utf8");
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      stats.malformed += 1;
      return;
    }
    if (frame["type"] === "ready" && typeof frame["sessionId"] === "string") {
      Object.assign(stats, { sessionId: frame["sessionId"] });
      return;
    }
    if (frame["type"] !== "s") return;
    stats.frames += 1;
    if (stats.lastStateAt !== undefined) stats.interFrameGaps.push(receivedAt - stats.lastStateAt);
    stats.firstStateAt ??= receivedAt;
    stats.lastStateAt = receivedAt;
    const tickSeq = typeof frame["t"] === "number" ? frame["t"] : undefined;
    if (tickSeq !== undefined && lastTickSeq !== undefined && tickSeq > lastTickSeq + 1) {
      stats.tickGaps += tickSeq - lastTickSeq - 1;
    }
    lastTickSeq = tickSeq;
  });
  ws.on("close", () => {
    stats.closedAt = performance.now();
  });

  await waitForOpen(ws, index);
  return { stats, ws };
}

async function join(index: number): Promise<JoinResponse> {
  const response = await fetch(`${DEMO_URL}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: `fanout-${index}` }),
  });
  const json = await response.json() as JoinResponse & { readonly error?: string; readonly detail?: string };
  if (!response.ok || !json.ok) {
    throw new Error(`join ${index} failed: HTTP ${response.status} ${json.detail ?? json.error ?? ""}`);
  }
  return json;
}

function buildReport(stats: readonly ClientStats[], elapsedMs: number): Record<string, unknown> {
  const frameRates = stats.map((stat) => {
    const span = stat.firstStateAt !== undefined && stat.lastStateAt !== undefined
      ? Math.max(1, stat.lastStateAt - stat.firstStateAt)
      : elapsedMs;
    return stat.frames / (span / 1_000);
  });
  const allGaps = stats.flatMap((stat) => stat.interFrameGaps);
  const droppedEstimate = allGaps.reduce(
    (total, gap) => total + Math.max(0, Math.round(gap / EXPECTED_TICK_MS) - 1),
    0,
  );
  return {
    clients: stats.length,
    elapsedMs: Math.round(elapsedMs),
    connected: stats.filter((stat) => stat.closedAt === undefined || stat.frames > 0).length,
    frames: sum(stats.map((stat) => stat.frames)),
    bytes: sum(stats.map((stat) => stat.bytes)),
    malformed: sum(stats.map((stat) => stat.malformed)),
    tickGaps: sum(stats.map((stat) => stat.tickGaps)),
    droppedEstimate,
    receiveHz: {
      p50: round(percentile(frameRates, 0.5), 2),
      p95: round(percentile(frameRates, 0.95), 2),
      min: round(Math.min(...frameRates), 2),
    },
    interFrameGapMs: {
      p50: round(percentile(allGaps, 0.5), 2),
      p95: round(percentile(allGaps, 0.95), 2),
      p99: round(percentile(allGaps, 0.99), 2),
      max: round(allGaps.length > 0 ? Math.max(...allGaps) : 0, 2),
    },
    perClient: stats.map((stat) => ({
      index: stat.index,
      playerId: stat.playerId,
      sessionId: stat.sessionId,
      frames: stat.frames,
      bytes: stat.bytes,
      tickGaps: stat.tickGaps,
      hz: round(frameRates[stat.index] ?? 0, 2),
    })),
  };
}

function waitForOpen(ws: WebSocket, index: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`client ${index} open timed out`)), 10_000);
    timer.unref();
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof Buffer) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(new Uint8Array(data)).toString("utf8");
}

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

main().catch((err) => {
  console.error("[fanout] FAIL", err);
  process.exit(1);
});
