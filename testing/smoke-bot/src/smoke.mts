// testing/smoke-bot — the vertical smoke driver.
//
// Steps (matches plan §"Goal (smoke definition)"):
//
//  1. Seed Redis with bundle manifest + game record so the placement router
//     has enough state to decide.
//  2. GET /games/:id/placement on the router. Expect a signed JWT and the
//     full webSocketUrl to open against the shard.
//  3. Open WebSocket; expect a "ready" frame from the hello-ws-echo bundle's
//     onPlayerConnect handler.
//  4. Send {type:'echo', body:'hello'} and expect an echo frame back.
//  5. Read the history.jsonl tail and assert the expected channel calls
//     show up with the same sessionId.

import { openSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { Redis } from "ioredis";
import WebSocket from "ws";

import {
  BUNDLE_KEY_PREFIX,
  GAME_KEY_PREFIX,
  type BundleRecord,
  type GameRecord,
} from "@pax-backend/ipc-protocol";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..");

const ROUTER_URL = process.env["PAX_ROUTER_URL"] ?? "http://127.0.0.1:9080";
const REDIS_URL = process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379";
const HISTORY_PATH =
  process.env["PAX_HISTORY_PATH"] ?? join(REPO_ROOT, "var", "history.jsonl");
const GAME_ID =
  process.env["PAX_SMOKE_GAME_ID"] ?? `smoke-${Date.now().toString(36)}`;
const PLAYER_ID = process.env["PAX_SMOKE_PLAYER_ID"] ?? "alice";
const BUNDLE_NAME = process.env["PAX_SMOKE_BUNDLE"] ?? "hello-ws-echo";

// ----- Placement wire shape (must match the Rust router) -----------------

interface PlacementResponse {
  readonly gameId: string;
  readonly shardId: string;
  readonly shardUrl: string;
  readonly webSocketUrl: string;
  readonly placementToken: string;
  readonly expiresAt: number;
  readonly runId: string;
  readonly bundleName: string;
  readonly serverTimings: Readonly<Record<string, number>>;
}

interface ReadyFrame {
  readonly type: "ready";
  readonly sessionId: string;
  readonly connectedAt: number;
}

interface EchoFrame {
  readonly type: "echo";
  readonly sessionId: string;
  readonly seq: number;
  readonly body: unknown;
}

type AnyFrame = ReadyFrame | EchoFrame | { readonly type: string; readonly [key: string]: unknown };

interface HistoryLine {
  readonly ts: string;
  readonly shardId: string;
  readonly event: string;
  readonly sessionId?: string;
  readonly [key: string]: unknown;
}

const log = (...args: unknown[]): void => {
  console.log("[smoke]", ...args);
};

function fail(msg: string, extra?: unknown): never {
  console.error("[smoke] FAIL:", msg, extra ?? "");
  process.exit(1);
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  log("config:", {
    ROUTER_URL,
    REDIS_URL,
    HISTORY_PATH,
    GAME_ID,
    PLAYER_ID,
    BUNDLE_NAME,
  });

  // Snapshot the history file's current size; we'll read only what got
  // appended during this smoke. Keeps assertion time O(events-this-run)
  // even when var/history.jsonl has accumulated MB across the dev session.
  let historyOffsetAtStart = 0;
  try {
    historyOffsetAtStart = statSync(HISTORY_PATH).size;
  } catch {
    // File may not exist yet on a fresh repo; we'll read from 0.
  }

  // 1. Seed Redis with bundle + game.
  const redis = new Redis(REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
  });
  redis.on("error", (err: Error) =>
    console.error("[smoke] redis error:", err.message),
  );

  const bundleRecord: BundleRecord = {
    bundleName: BUNDLE_NAME,
    manifest: {
      compatTagProduced: "smoke:v1",
      compatTagsAccepted: ["smoke:v1"],
      runtimeContractRequired: 1,
    },
    publishedAt: Date.now(),
  };
  const gameRecord: GameRecord = {
    gameId: GAME_ID,
    bundleName: BUNDLE_NAME,
    createdAt: Date.now(),
  };
  await redis.set(`${BUNDLE_KEY_PREFIX}${BUNDLE_NAME}`, JSON.stringify(bundleRecord));
  await redis.set(`${GAME_KEY_PREFIX}${GAME_ID}`, JSON.stringify(gameRecord));
  log("seeded bundles + games keys");

  // 2. Placement.
  const placementUrl = `${ROUTER_URL}/games/${encodeURIComponent(
    GAME_ID,
  )}/placement?userId=${encodeURIComponent(PLAYER_ID)}`;
  log("GET", placementUrl);
  const placementResp = await fetch(placementUrl);
  if (!placementResp.ok) {
    const text = await placementResp.text();
    fail(`placement ${placementResp.status}: ${text}`);
  }
  const placement = (await placementResp.json()) as PlacementResponse;
  log("placement:", {
    shardId: placement.shardId,
    webSocketUrl: placement.webSocketUrl,
    expiresAt: placement.expiresAt,
  });
  if (typeof placement.webSocketUrl !== "string") {
    fail("placement missing webSocketUrl", placement);
  }

  // 3. Open WebSocket — must request rivet subprotocols.
  log("opening WS:", placement.webSocketUrl);
  const rivetProtocols = [
    "rivet",
    "rivet_encoding.json",
    `rivet_conn_params.${encodeURIComponent(JSON.stringify({ name: GAME_ID }))}`,
  ];
  const ws = new WebSocket(placement.webSocketUrl, rivetProtocols);
  let readyMsg: ReadyFrame | null = null;
  let echoMsg: EchoFrame | null = null;

  ws.on("open", () => log("ws open"));
  ws.on("close", (code: number, reason: Buffer) =>
    log("ws close", { code, reason: reason.toString("utf8") }),
  );
  ws.on("error", (err: Error) => {
    fail("ws error: " + err.message);
  });

  await new Promise<void>((resolveOpen, rejectOpen) => {
    const t = setTimeout(() => rejectOpen(new Error("ws open timeout")), 10_000);
    ws.once("open", () => {
      clearTimeout(t);
      resolveOpen();
    });
    ws.once("error", (err: Error) => {
      clearTimeout(t);
      rejectOpen(err);
    });
  });

  ws.on("message", (data: WebSocket.RawData) => {
    let parsed: AnyFrame;
    try {
      parsed = JSON.parse(data.toString()) as AnyFrame;
    } catch {
      log("non-JSON ws frame", data.toString());
      return;
    }
    if (parsed.type === "ready") readyMsg = parsed as ReadyFrame;
    if (parsed.type === "echo") echoMsg = parsed as EchoFrame;
  });

  // 4. Wait for "ready" frame.
  await waitFor(() => readyMsg !== null, 10_000, "ready frame");
  const ready = readyMsg as unknown as ReadyFrame;
  log("ready frame received:", ready);
  if (!ready.sessionId.startsWith("ses_")) {
    fail("ready frame missing sessionId", ready);
  }

  // 5. Send echo, expect echo back.
  const body = { hello: "world", t: Date.now() };
  ws.send(JSON.stringify({ type: "echo", body }));
  log("sent echo request");

  await waitFor(() => echoMsg !== null, 10_000, "echo frame");
  const echo = echoMsg as unknown as EchoFrame;
  log("echo received:", echo);
  if (echo.sessionId !== ready.sessionId) {
    fail("echo sessionId differs from ready sessionId", { echo, ready });
  }
  // Bundle echoes the FULL onPlayerMessage payload's `body` field; parent
  // forwards the incoming JSON as `body`. So echo.body === {type:'echo', body}.
  const want = { type: "echo", body };
  if (JSON.stringify(echo.body) !== JSON.stringify(want)) {
    fail("echo body does not match", { sent: want, got: echo.body });
  }

  ws.close(1000, "smoke done");
  await new Promise<void>((r) => setTimeout(r, 500));

  // 6. Read ONLY the history bytes appended during this smoke run, and
  //    parse them as JSONL. Avoids re-reading the full accumulated file
  //    so smoke time stays O(events-this-run).
  const sizeNow = statSync(HISTORY_PATH).size;
  const sliceBytes = sizeNow - historyOffsetAtStart;
  if (sliceBytes <= 0) {
    fail("no history written during smoke", { historyOffsetAtStart, sizeNow });
  }
  const fd = openSync(HISTORY_PATH, "r");
  const buf = Buffer.alloc(sliceBytes);
  readSync(fd, buf, 0, sliceBytes, historyOffsetAtStart);
  const tailLines = buf
    .toString("utf8")
    .trim()
    .split("\n")
    .map((l: string): HistoryLine | null => {
      try {
        return JSON.parse(l) as HistoryLine;
      } catch {
        return null;
      }
    })
    .filter((l): l is HistoryLine => l !== null);

  const sessionLines = tailLines.filter(
    (l) => l.sessionId === ready.sessionId,
  );
  log("history sessionId entries:", sessionLines.length);

  const events = sessionLines.map((l) => l.event);
  const must = ["session.opened", "ws.send", "onPlayerMessage", "session.closed"] as const;
  for (const m of must) {
    if (!events.includes(m)) {
      fail(`history missing event ${m}`, { events });
    }
  }
  const logEvents = tailLines.filter((l) => l.event === "log.emit");
  if (logEvents.length < 2) {
    fail(
      "expected at least 2 log.emit entries from bundle (onPlayerConnect + onPlayerMessage)",
      { logEvents },
    );
  }

  const elapsedMs = Math.round(performance.now() - startedAt);
  log(`PASS — vertical smoke green in ${elapsedMs}ms`);
  log(`sessionId=${ready.sessionId}`);
  log(`history lines with sessionId: ${sessionLines.length}`);

  await redis.quit();
  process.exit(0);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeoutMs) {
      fail(`timeout waiting for ${label}`);
    }
    await new Promise<void>((r) => setTimeout(r, 25));
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  fail("uncaught", msg);
});
