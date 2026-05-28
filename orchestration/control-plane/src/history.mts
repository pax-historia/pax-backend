import { existsSync, readFileSync } from "node:fs";

export interface HistoryEvent {
  readonly ts: string;
  readonly shardId: string;
  readonly event: string;
  readonly gameId?: string;
  readonly playerId?: string;
  readonly sessionId?: string;
  readonly [key: string]: unknown;
}

export interface HistoryQuery {
  readonly event?: string;
  readonly gameId?: string;
  readonly playerId?: string;
  readonly sessionId?: string;
  readonly shardId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: number;
  readonly limit: number;
}

export interface HistoryQueryResult {
  readonly events: readonly HistoryEvent[];
  readonly nextCursor: number | null;
}

export interface SessionRecordView {
  readonly sessionId: string;
  readonly playerId: string;
  readonly gameId: string;
  readonly connectedAt: number;
  readonly disconnectedAt?: number;
  readonly reason?: string;
  readonly shardId: string;
  readonly jwtClaims?: unknown;
}

export interface SessionQuery {
  readonly from?: string;
  readonly to?: string;
  readonly playerId?: string;
}

export function queryHistory(
  historyPath: string,
  query: HistoryQuery,
): HistoryQueryResult {
  const events = readHistory(historyPath);
  const fromMs = query.from ? Date.parse(query.from) : undefined;
  const toMs = query.to ? Date.parse(query.to) : undefined;
  const out: HistoryEvent[] = [];
  let nextCursor: number | null = null;

  for (let index = Math.max(0, query.cursor ?? 0); index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    if (!matchesHistory(event, query, fromMs, toMs)) continue;
    if (out.length >= query.limit) {
      nextCursor = index;
      break;
    }
    out.push(event);
  }

  return { events: out, nextCursor };
}

export function sessionsForGame(
  historyPath: string,
  gameId: string,
  query: SessionQuery = {},
): readonly SessionRecordView[] {
  return Array.from(sessionMap(readHistory(historyPath)).values())
    .filter((session) => session.gameId === gameId)
    .filter((session) => matchesSession(session, query))
    .sort((a, b) => a.connectedAt - b.connectedAt);
}

export function connectedPlayersForGame(
  historyPath: string,
  gameId: string,
): readonly SessionRecordView[] {
  return sessionsForGame(historyPath, gameId).filter(
    (session) => session.disconnectedAt === undefined,
  );
}

export function sessionById(
  historyPath: string,
  sessionId: string,
): SessionRecordView | undefined {
  return sessionMap(readHistory(historyPath)).get(sessionId);
}

export function lastActivityAtForGame(
  historyPath: string,
  gameId: string,
): number | undefined {
  let lastActivityAt: number | undefined;
  for (const event of readHistory(historyPath)) {
    if (event.gameId !== gameId) continue;
    const at = Date.parse(event.ts);
    if (!Number.isNaN(at)) lastActivityAt = at;
  }
  return lastActivityAt;
}

function readHistory(historyPath: string): readonly HistoryEvent[] {
  if (!existsSync(historyPath)) return [];
  return readFileSync(historyPath, "utf8")
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return [];
      try {
        const parsed = JSON.parse(trimmed) as Partial<HistoryEvent>;
        if (
          typeof parsed.ts === "string" &&
          typeof parsed.shardId === "string" &&
          typeof parsed.event === "string"
        ) {
          return [parsed as HistoryEvent];
        }
      } catch {
        return [];
      }
      return [];
    });
}

function sessionMap(events: readonly HistoryEvent[]): Map<string, SessionRecordView> {
  const sessions = new Map<string, SessionRecordView>();
  for (const event of events) {
    if (event.event !== "session.opened" && event.event !== "session.closed") {
      continue;
    }
    if (
      typeof event.sessionId !== "string" ||
      typeof event.playerId !== "string" ||
      typeof event.gameId !== "string"
    ) {
      continue;
    }
    if (event.event === "session.opened") {
      sessions.set(event.sessionId, {
        sessionId: event.sessionId,
        playerId: event.playerId,
        gameId: event.gameId,
        connectedAt:
          typeof event["connectedAt"] === "number"
            ? event["connectedAt"]
            : Date.parse(event.ts),
        shardId: event.shardId,
        jwtClaims: event["jwtClaims"],
      });
      continue;
    }
    const existing = sessions.get(event.sessionId);
    const closed: SessionRecordView = {
      sessionId: event.sessionId,
      playerId: event.playerId,
      gameId: event.gameId,
      connectedAt: existing?.connectedAt ?? Date.parse(event.ts),
      disconnectedAt: Date.parse(event.ts),
      reason: typeof event["reason"] === "string" ? event["reason"] : undefined,
      shardId: existing?.shardId ?? event.shardId,
      jwtClaims: existing?.jwtClaims,
    };
    sessions.set(event.sessionId, closed);
  }
  return sessions;
}

function matchesHistory(
  event: HistoryEvent,
  query: HistoryQuery,
  fromMs: number | undefined,
  toMs: number | undefined,
): boolean {
  if (query.event && event.event !== query.event) return false;
  if (query.gameId && event.gameId !== query.gameId) return false;
  if (query.playerId && event.playerId !== query.playerId) return false;
  if (query.sessionId && event.sessionId !== query.sessionId) return false;
  if (query.shardId && event.shardId !== query.shardId) return false;
  const eventMs = Date.parse(event.ts);
  if (fromMs !== undefined && eventMs < fromMs) return false;
  if (toMs !== undefined && eventMs > toMs) return false;
  return true;
}

function matchesSession(session: SessionRecordView, query: SessionQuery): boolean {
  if (query.playerId && session.playerId !== query.playerId) return false;
  const fromMs = query.from ? Date.parse(query.from) : undefined;
  const toMs = query.to ? Date.parse(query.to) : undefined;
  if (fromMs !== undefined && (session.disconnectedAt ?? Number.POSITIVE_INFINITY) < fromMs) {
    return false;
  }
  if (toMs !== undefined && session.connectedAt > toMs) {
    return false;
  }
  return true;
}
