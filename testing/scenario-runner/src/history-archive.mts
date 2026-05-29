import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from "@aws-sdk/client-s3";

import type { HistoryEvent } from "@pax-backend/oracles-lib";

export interface ArchivedHistoryCollection {
  readonly enabled: boolean;
  readonly appendedEvents: number;
  readonly scannedObjects: number;
  readonly matchedObjects: readonly string[];
  readonly reason?: string;
}

export interface ArchivedHistoryInput {
  readonly historyPath: string;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly gameIds?: readonly string[];
  readonly windowPaddingMs?: number;
  readonly flushWaitMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ControlPlaneHistoryCollection {
  readonly enabled: boolean;
  readonly appendedEvents: number;
  readonly scannedEvents: number;
  readonly gameIds: readonly string[];
  readonly reason?: string;
}

export interface ControlPlaneHistoryInput {
  readonly historyPath: string;
  readonly controlPlaneUrl?: string;
  readonly gameIds: readonly string[];
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
  readonly windowPaddingMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export async function appendArchivedHistory(input: ArchivedHistoryInput): Promise<ArchivedHistoryCollection> {
  const env = input.env ?? process.env;
  if (env["PAX_SCENARIO_COLLECT_ARCHIVE_HISTORY"] === "0") {
    return disabled("archive history collection disabled by PAX_SCENARIO_COLLECT_ARCHIVE_HISTORY=0");
  }

  const bucket = env["BUCKET_NAME"] ?? env["PAX_TIGRIS_BUCKET"];
  const endpoint = env["AWS_ENDPOINT_URL_S3"];
  if (!bucket || !endpoint) {
    return disabled("BUCKET_NAME/PAX_TIGRIS_BUCKET and AWS_ENDPOINT_URL_S3 are required");
  }

  const flushWaitMs = positiveInt(env["PAX_SCENARIO_ARCHIVE_FLUSH_WAIT_MS"], input.flushWaitMs ?? 15_000);
  if (flushWaitMs > 0) await sleep(flushWaitMs);

  const paddingMs = positiveInt(env["PAX_SCENARIO_ARCHIVE_WINDOW_PADDING_MS"], input.windowPaddingMs ?? 60_000);
  const fromMs = input.startedAtMs - paddingMs;
  const toMs = input.finishedAtMs + paddingMs;
  const gameIdFilter = input.gameIds && input.gameIds.length > 0 ? new Set(input.gameIds) : undefined;
  const client = new S3Client({
    region: env["AWS_REGION"] ?? "auto",
    endpoint,
    forcePathStyle: true,
  });
  const objectRows = await listHistoryObjects(client, bucket, datePrefixes(fromMs, toMs));
  const selectedObjects = objectRows.filter((row) => {
    const modifiedAt = row.LastModified?.getTime();
    return modifiedAt !== undefined && modifiedAt >= fromMs && modifiedAt <= toMs;
  });

  const existing = loadExistingEventKeys(input.historyPath);
  const filter = historyEventFilter(env);
  let appendedEvents = 0;
  const matchedObjects: string[] = [];
  for (const row of selectedObjects) {
    if (!row.Key) continue;
    const objectEvents = await readHistoryObject(client, bucket, row.Key);
    const inWindow = objectEvents.filter(
      (event) =>
        eventInWindow(event, fromMs, toMs) &&
        eventMatchesGameFilter(event, gameIdFilter) &&
        filter(event),
    );
    if (inWindow.length === 0) continue;
    matchedObjects.push(row.Key);
    appendedEvents += appendUniqueEvents(input.historyPath, inWindow, existing);
  }

  return {
    enabled: true,
    appendedEvents,
    scannedObjects: selectedObjects.length,
    matchedObjects,
  };
}

export async function appendControlPlaneHistory(
  input: ControlPlaneHistoryInput,
): Promise<ControlPlaneHistoryCollection> {
  if (!input.controlPlaneUrl) {
    return controlPlaneDisabled("control-plane URL is required");
  }
  const controlPlaneUrl = input.controlPlaneUrl;
  const env = input.env ?? process.env;
  const concurrency = Math.max(
    1,
    positiveInt(env["PAX_SCENARIO_CONTROL_HISTORY_CONCURRENCY"], 16),
  );
  const paddingMs = input.windowPaddingMs ?? 1_000;
  const from = new Date(input.startedAtMs - paddingMs).toISOString();
  const to = new Date(input.finishedAtMs + paddingMs).toISOString();
  const existing = loadExistingEventKeys(input.historyPath);
  const filter = historyEventFilter(env);
  let appendedEvents = 0;
  let scannedEvents = 0;
  try {
    await forEachConcurrent(input.gameIds, concurrency, async (gameId) => {
      const events = await fetchControlPlaneHistory(controlPlaneUrl, gameId, from, to);
      scannedEvents += events.length;
      appendedEvents += appendUniqueEvents(
        input.historyPath,
        events.filter((event) => filter(event)),
        existing,
      );
    });
  } catch (err) {
    return controlPlaneDisabled(err instanceof Error ? err.message : String(err));
  }
  return {
    enabled: true,
    appendedEvents,
    scannedEvents,
    gameIds: input.gameIds,
  };
}

function disabled(reason: string): ArchivedHistoryCollection {
  return {
    enabled: false,
    appendedEvents: 0,
    scannedObjects: 0,
    matchedObjects: [],
    reason,
  };
}

function controlPlaneDisabled(reason: string): ControlPlaneHistoryCollection {
  return {
    enabled: false,
    appendedEvents: 0,
    scannedEvents: 0,
    gameIds: [],
    reason,
  };
}

async function fetchControlPlaneHistory(
  controlPlaneUrl: string,
  gameId: string,
  from: string,
  to: string,
): Promise<readonly HistoryEvent[]> {
  const events: HistoryEvent[] = [];
  let cursor: number | null | undefined;
  do {
    const url = new URL("/admin/history", trimTrailingSlash(controlPlaneUrl));
    url.searchParams.set("gameId", gameId);
    url.searchParams.set("from", from);
    url.searchParams.set("to", to);
    url.searchParams.set("limit", "1000");
    if (cursor !== undefined && cursor !== null) {
      url.searchParams.set("cursor", String(cursor));
    }
    const response = await fetch(url);
    const body = (await response.json()) as unknown;
    if (!response.ok) {
      throw new Error(`control-plane history failed for ${gameId}: HTTP ${response.status}`);
    }
    if (!isRecord(body) || !Array.isArray(body["events"])) {
      throw new Error(`control-plane history returned an invalid response for ${gameId}`);
    }
    events.push(...(body["events"] as HistoryEvent[]));
    cursor = typeof body["nextCursor"] === "number" ? body["nextCursor"] : null;
  } while (cursor !== null);
  return events;
}

async function forEachConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        await fn(values[index] as T);
      }
    }),
  );
}

async function listHistoryObjects(
  client: S3Client,
  bucket: string,
  prefixes: readonly string[],
): Promise<readonly _Object[]> {
  const rows: _Object[] = [];
  for (const Prefix of prefixes) {
    let ContinuationToken: string | undefined;
    do {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix,
          ContinuationToken,
        }),
      );
      rows.push(...(out.Contents ?? []));
      ContinuationToken = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }
  return rows;
}

async function readHistoryObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<readonly HistoryEvent[]> {
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!out.Body) return [];
  const compressed = await responseBodyToBuffer(out.Body);
  const raw = gunzipSync(compressed).toString("utf8");
  return raw
    .split(/\r?\n/)
    .flatMap((line) => parseHistoryLine(line))
    .flatMap((entry) => normalizeHistoryEntry(entry));
}

async function responseBodyToBuffer(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body && typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("S3 object body is not readable");
}

function parseHistoryLine(line: string): readonly unknown[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

function normalizeHistoryEntry(entry: unknown): readonly HistoryEvent[] {
  if (!isRecord(entry)) return [];
  const message = typeof entry["message"] === "string" ? parseEmbeddedMessage(entry["message"]) : undefined;
  const merged = message ? message : entry;
  if (typeof merged["event"] !== "string") return [];
  const ts =
    stringField(merged, "ts") ??
    stringField(entry, "ts") ??
    stringField(entry, "timestamp");
  const shardId =
    stringField(merged, "shardId") ??
    stringField(merged, "shard_id") ??
    stringField(entry, "shardId") ??
    stringField(entry, "shard_id");
  const paxSeq = numberField(merged, "pax_seq") ?? numberField(entry, "pax_seq");
  if (!ts || !shardId || paxSeq === undefined) return [];
  return [
    {
      ...merged,
      ts,
      shardId,
      pax_seq: paxSeq,
      event: merged["event"],
    } as HistoryEvent,
  ];
}

function appendUniqueEvents(
  path: string,
  events: readonly HistoryEvent[],
  existing: Set<string>,
): number {
  const uniqueEvents = events
    .filter((event) => {
      const key = eventKey(event);
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    })
    .sort(compareHistoryEvents);
  if (uniqueEvents.length === 0) return 0;
  appendFileSync(
    path,
    uniqueEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
  return uniqueEvents.length;
}

function historyEventFilter(env: NodeJS.ProcessEnv): (event: HistoryEvent) => boolean {
  const rawAllowlist = env["PAX_SCENARIO_HISTORY_EVENT_ALLOWLIST"];
  if (rawAllowlist) {
    const allowed = new Set(
      rawAllowlist
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    );
    if (allowed.size > 0) return (event) => criticalHistoryEvent(event) || allowed.has(event.event);
  }
  if (env["PAX_SCENARIO_HISTORY_PROFILE"] === "scale") {
    return (event) => criticalHistoryEvent(event) || SCALE_HISTORY_EVENTS.has(event.event);
  }
  return () => true;
}

const SCALE_HISTORY_EVENTS = new Set([
  "actor.stop",
  "api.invoke.request",
  "api.invoke.response",
  "api.invoke.wire",
  "broker.start",
  "broker.stop",
  "child.exit",
  "connection.refused",
  "game.created",
  "game.released",
  "game.woke",
  "handler.error",
  "isolate.fatal",
  "isolate.ready",
  "onPlayerMessage",
  "parent.ready",
  "placement.accepted",
  "placement.refused",
  "placement.rejected",
  "runner.crash",
  "session.closed",
  "session.forceDisconnect",
  "session.opened",
  "ws.send",
]);

function criticalHistoryEvent(event: HistoryEvent): boolean {
  const name = event.event.toLowerCase();
  return (
    name.includes("error") ||
    name.includes("fail") ||
    name.includes("fatal") ||
    name.includes("reject") ||
    name.includes("refus") ||
    name.includes("warning") ||
    name.includes("budget")
  );
}

function parseEmbeddedMessage(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function eventInWindow(event: HistoryEvent, fromMs: number, toMs: number): boolean {
  const ts = typeof event.ts === "string" ? Date.parse(event.ts) : NaN;
  return Number.isFinite(ts) && ts >= fromMs && ts <= toMs;
}

function eventMatchesGameFilter(
  event: HistoryEvent,
  gameIdFilter: ReadonlySet<string> | undefined,
): boolean {
  if (!gameIdFilter) return true;
  const gameId = (event as { readonly gameId?: unknown }).gameId;
  return typeof gameId === "string" && gameIdFilter.has(gameId);
}

function loadExistingEventKeys(path: string): Set<string> {
  const keys = new Set<string>();
  if (!existsSync(path)) return keys;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as HistoryEvent;
      keys.add(eventKey(parsed));
    } catch {
      continue;
    }
  }
  return keys;
}

function eventKey(event: HistoryEvent): string {
  return [
    event.shardId ?? "",
    event.pax_seq ?? "",
    event.ts ?? "",
    event.event,
    event.gameId ?? "",
    event.sessionId ?? "",
    event.requestId ?? "",
  ].join("\0");
}

function compareHistoryEvents(left: HistoryEvent, right: HistoryEvent): number {
  const shard = String(left.shardId ?? "").localeCompare(String(right.shardId ?? ""));
  if (shard !== 0) return shard;
  const leftSeq = typeof left.pax_seq === "number" ? left.pax_seq : 0;
  const rightSeq = typeof right.pax_seq === "number" ? right.pax_seq : 0;
  if (leftSeq !== rightSeq) return leftSeq - rightSeq;
  return String(left.ts ?? "").localeCompare(String(right.ts ?? ""));
}

function datePrefixes(fromMs: number, toMs: number): readonly string[] {
  const prefixes: string[] = [];
  const cursor = new Date(new Date(fromMs).toISOString().slice(0, 10));
  const end = new Date(new Date(toMs).toISOString().slice(0, 10));
  while (cursor.getTime() <= end.getTime()) {
    prefixes.push(`history/date=${cursor.toISOString().slice(0, 10)}/`);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return prefixes;
}

function stringField(record: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Readonly<Record<string, unknown>>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)));
}
