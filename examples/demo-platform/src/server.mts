// demo-platform — a paper-thin stand-in for the "host platform" (the vercel
// backend + frontend) that a real consumer would build on top of the substrate.
//
// It does exactly three host-platform jobs:
//   1. Serve a static browser client (the cube renderer).
//   2. On /join, whitelist the visitor and ask the placement router for a
//      WebSocket URL + token (the substrate's only public handshake).
//   3. On --setup, upload the cube-sandbox bundle and create the room game.
//
// It holds the admin/router URLs (reachable over the Fly private network, or
// localhost in dev). Browsers only ever talk to this server and the shard WS.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const CONTROL_URL = trimSlash(env("PAX_CONTROL_URL", "http://127.0.0.1:9070"));
const ROUTER_URL = trimSlash(env("PAX_ROUTER_URL", "http://127.0.0.1:9080"));
const ADMIN_TOKEN = env("PAX_LOCAL_ENGINE_ADMIN_TOKEN", "");
const GAME_ID = env("PAX_DEMO_GAME_ID", "cube-room");
const BUNDLE_NAME = env("PAX_DEMO_BUNDLE", "cube-sandbox");
const BIND = env("PAX_DEMO_BIND", "127.0.0.1:8088");

const MANIFEST = {
  compatTagProduced: "cubes:v1",
  compatTagsAccepted: ["cubes:v1"],
  runtimeContractRequired: 1,
} as const;

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

if (process.argv.includes("--setup")) {
  await runSetup(process.argv.includes("--force"));
  process.exit(0);
}

main();

function main(): void {
  const { host, port } = parseBind(BIND);
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      sendJson(res, 500, { error: "demoInternal", detail: String(err instanceof Error ? err.message : err) });
    });
  });
  server.listen(port, host, () => {
    log(`demo-platform listening on http://${host}:${port}`);
    log(`  control=${CONTROL_URL} router=${ROUTER_URL} game=${GAME_ID} bundle=${BUNDLE_NAME}`);
  });
  // Self-provision the bundle + room on boot so deploying the image is enough.
  // Idempotent; retries while the control plane is still coming up.
  void bootstrapWithRetry();
}

async function bootstrapWithRetry(): Promise<void> {
  const force = process.env["PAX_DEMO_FORCE_SETUP"] === "1";
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await runSetup(force);
      return;
    } catch (err) {
      log(`bootstrap attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}; retrying in 3s`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  log("bootstrap gave up; /join will still try to create the game on demand");
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/join") {
    return await handleJoin(req, res);
  }
  if (req.method === "GET") {
    return await serveStatic(url.pathname, res);
  }
  sendJson(res, 404, { error: "notFound" });
}

async function handleJoin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req);
  const requested = typeof body?.["name"] === "string" ? body["name"].trim() : "";
  const playerId = makePlayerId(requested);

  try {
    await ensureGame();
    await addAllowedPlayer(playerId);
    const placement = await requestPlacement(playerId);
    sendJson(res, 200, {
      ok: true,
      gameId: GAME_ID,
      playerId,
      webSocketUrl: placement.webSocketUrl,
      placementToken: placement.placementToken,
    });
  } catch (err) {
    log("join failed:", err instanceof Error ? err.message : String(err));
    sendJson(res, 502, { ok: false, error: "joinFailed", detail: String(err instanceof Error ? err.message : err) });
  }
}

// ----- substrate calls ----------------------------------------------------

async function ensureGame(): Promise<void> {
  const res = await adminFetch(`/admin/games`, {
    method: "POST",
    body: { gameId: GAME_ID, bundleName: BUNDLE_NAME, allowedPlayers: [] },
  });
  // 201 created, or 409 already exists — both fine.
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(`ensureGame: HTTP ${res.status} ${await res.text()}`);
  }
}

async function addAllowedPlayer(playerId: string): Promise<void> {
  const res = await adminFetch(
    `/admin/games/${encodeURIComponent(GAME_ID)}/allowed-players/${encodeURIComponent(playerId)}`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`addAllowedPlayer: HTTP ${res.status} ${await res.text()}`);
}

interface PlacementResponse {
  readonly webSocketUrl: string;
  readonly placementToken: string;
}

async function requestPlacement(playerId: string): Promise<PlacementResponse> {
  const res = await fetch(`${ROUTER_URL}/placement`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ gameId: GAME_ID, playerId }),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`placement: HTTP ${res.status} ${text}`);
  const json = JSON.parse(text) as PlacementResponse;
  if (typeof json.webSocketUrl !== "string") throw new Error("placement missing webSocketUrl");
  return json;
}

async function runSetup(force: boolean): Promise<void> {
  log(`setup: control=${CONTROL_URL} game=${GAME_ID} bundle=${BUNDLE_NAME} force=${force}`);
  if (force) {
    await adminFetch(`/admin/games/${encodeURIComponent(GAME_ID)}`, { method: "DELETE" }).catch(() => undefined);
    await adminFetch(`/admin/bundles/${encodeURIComponent(BUNDLE_NAME)}`, { method: "DELETE" }).catch(() => undefined);
  }

  const lookup = await adminFetch(`/admin/bundles/${encodeURIComponent(BUNDLE_NAME)}`, { method: "GET" });
  if (lookup.status === 404) {
    const source = await readBundleSource();
    const up = await adminFetch(`/admin/bundles/${encodeURIComponent(BUNDLE_NAME)}`, {
      method: "POST",
      body: { manifest: MANIFEST, source },
      timeoutMs: 60000,
    });
    if (!up.ok) throw new Error(`bundle upload: HTTP ${up.status} ${await up.text()}`);
    log(`uploaded bundle ${BUNDLE_NAME} (${source.length} bytes)`);
  } else if (lookup.ok) {
    log(`bundle ${BUNDLE_NAME} already present`);
  } else {
    throw new Error(`bundle lookup: HTTP ${lookup.status} ${await lookup.text()}`);
  }

  const created = await adminFetch(`/admin/games`, {
    method: "POST",
    body: { gameId: GAME_ID, bundleName: BUNDLE_NAME, allowedPlayers: [] },
  });
  if (created.status === 201) log(`created game ${GAME_ID}`);
  else if (created.status === 409) log(`game ${GAME_ID} already exists`);
  else throw new Error(`create game: HTTP ${created.status} ${await created.text()}`);
  log("setup complete");
}

async function readBundleSource(): Promise<string> {
  const path = join(REPO_ROOT, "examples", "bundles", BUNDLE_NAME, "dist", "bundle.js");
  const { readFile } = await import("node:fs/promises");
  return readFile(path, "utf8");
}

interface AdminInit {
  readonly method: "GET" | "POST" | "DELETE";
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

function adminFetch(path: string, init: AdminInit): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (ADMIN_TOKEN) headers["authorization"] = `Bearer ${ADMIN_TOKEN}`;
  return fetch(`${CONTROL_URL}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 15000),
  });
}

// ----- static + http helpers ----------------------------------------------

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  try {
    const info = await stat(full);
    if (!info.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": MIME[extname(full)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    createReadStream(full).pipe(res);
  } catch {
    sendJson(res, 404, { error: "notFound", path: pathname });
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(text);
}

function makePlayerId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 16);
  const rand = Math.random().toString(36).slice(2, 8);
  return slug ? `${slug}-${rand}` : `guest-${rand}`;
}

function parseBind(bind: string): { host: string; port: number } {
  const idx = bind.lastIndexOf(":");
  const host = idx > 0 ? bind.slice(0, idx) : "0.0.0.0";
  const port = Number.parseInt(idx > 0 ? bind.slice(idx + 1) : bind, 10);
  return { host: host.replace(/^\[|\]$/g, ""), port: Number.isFinite(port) ? port : 8088 };
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function log(...args: unknown[]): void {
  console.log("[demo-platform]", ...args);
}
