import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
const HISTORY_PATH = process.env["PAX_HISTORY_PATH"] ?? join(REPO_ROOT, "var", "history.jsonl");
const GAME_ID = process.env["PAX_HISTORY_GAME_ID"];
const SINCE_MS = parseSince(process.env["PAX_HISTORY_SINCE"]);

interface HistoryEvent {
  readonly ts?: string;
  readonly event?: string;
  readonly gameId?: string;
  readonly recipientCount?: number;
  readonly bytes?: number;
  readonly error?: string;
}

interface GameSummary {
  readonly gameId: string;
  firstTs?: number;
  lastTs?: number;
  wsSendCount: number;
  recipientCount: number;
  bytes: number;
  rejections: Map<string, number>;
}

async function main(): Promise<void> {
  const raw = await readFile(HISTORY_PATH, "utf8");
  const summaries = new Map<string, GameSummary>();
  let malformed = 0;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event: HistoryEvent;
    try {
      event = JSON.parse(line) as HistoryEvent;
    } catch {
      malformed += 1;
      continue;
    }
    const ts = event.ts ? Date.parse(event.ts) : NaN;
    if (SINCE_MS !== undefined && (!Number.isFinite(ts) || ts < SINCE_MS)) continue;
    if (!event.gameId || (GAME_ID && event.gameId !== GAME_ID)) continue;
    if (event.event !== "ws.send" && event.event !== "ws.send.rejected") continue;
    const summary = getSummary(summaries, event.gameId);
    if (Number.isFinite(ts)) {
      summary.firstTs = summary.firstTs === undefined ? ts : Math.min(summary.firstTs, ts);
      summary.lastTs = summary.lastTs === undefined ? ts : Math.max(summary.lastTs, ts);
    }
    if (event.event === "ws.send") {
      summary.wsSendCount += 1;
      summary.recipientCount += numberOr(event.recipientCount, 0);
      summary.bytes += numberOr(event.bytes, 0);
    } else {
      const error = typeof event.error === "string" ? event.error : "unknown";
      summary.rejections.set(error, (summary.rejections.get(error) ?? 0) + 1);
    }
  }

  const games = [...summaries.values()]
    .sort((left, right) => right.bytes - left.bytes)
    .map((summary) => {
      const durationSec = summary.firstTs !== undefined && summary.lastTs !== undefined
        ? Math.max(1, (summary.lastTs - summary.firstTs) / 1_000)
        : 1;
      return {
        gameId: summary.gameId,
        durationSec: round(durationSec, 2),
        wsSendCount: summary.wsSendCount,
        sendsPerSec: round(summary.wsSendCount / durationSec, 2),
        recipientCount: summary.recipientCount,
        recipientsPerSend: summary.wsSendCount > 0 ? round(summary.recipientCount / summary.wsSendCount, 2) : 0,
        bytes: summary.bytes,
        bytesPerSec: round(summary.bytes / durationSec, 2),
        rejections: Object.fromEntries([...summary.rejections.entries()].sort(([left], [right]) => left.localeCompare(right))),
      };
    });

  console.log(JSON.stringify({
    historyPath: HISTORY_PATH,
    gameFilter: GAME_ID ?? null,
    since: SINCE_MS === undefined ? null : new Date(SINCE_MS).toISOString(),
    malformed,
    games,
  }, null, 2));
}

function getSummary(summaries: Map<string, GameSummary>, gameId: string): GameSummary {
  let summary = summaries.get(gameId);
  if (!summary) {
    summary = {
      gameId,
      wsSendCount: 0,
      recipientCount: 0,
      bytes: 0,
      rejections: new Map(),
    };
    summaries.set(gameId, summary);
  }
  return summary;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function parseSince(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid PAX_HISTORY_SINCE: ${value}`);
  return parsed;
}

main().catch((err) => {
  console.error("[history-summary] FAIL", err);
  process.exit(1);
});
