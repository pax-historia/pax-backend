import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface CliOptions {
  readonly routerUrl: string;
  readonly shardUrl: string;
  readonly controlUrl: string;
  readonly machineIds: readonly string[];
  readonly gameId: string;
  readonly playerId: string;
  readonly bundleName: string;
  readonly outputPath: string;
}

interface BundleModule {
  readonly default?: {
    readonly manifest?: BundleManifest;
  };
}

interface BundleManifest {
  readonly compatTagProduced: string;
  readonly compatTagsAccepted: readonly string[];
  readonly runtimeContractRequired: number;
}

interface PlacementResponse {
  readonly gameId: string;
  readonly shardId: string;
  readonly shardUrl: string;
  readonly webSocketUrl: string;
  readonly placementToken: string;
  readonly flyMachineId?: string;
  readonly bundleName: string;
  readonly traceId: string;
}

interface ReadyFrame {
  readonly type: "ready";
  readonly sessionId: string;
}

interface HealthResponse {
  readonly shardId?: string;
  readonly capacity?: {
    readonly url?: string;
  };
}

interface SessionProof {
  readonly mode: "normal" | "forced-wrong-machine";
  readonly forcedMachineId?: string;
  readonly readyOk: boolean;
  readonly readySessionId: string;
}

interface WsRoutingProof {
  readonly schema_version: 1;
  readonly kind: "fly-ws-routing-proof";
  readonly started_at: string;
  readonly router_url: string;
  readonly shard_url: string;
  readonly game_id: string;
  readonly player_id: string;
  readonly bundle_name: string;
  readonly placement: {
    readonly shard_id: string;
    readonly fly_machine_id?: string;
    readonly shard_url: string;
    readonly websocket_host: string;
    readonly websocket_path: string;
    readonly has_placement_token: boolean;
    readonly has_instance_query_params: boolean;
    readonly trace_id: string;
  };
  readonly forced_health_checks: Readonly<Record<string, HealthResponse>>;
  readonly sessions: readonly SessionProof[];
  readonly summary: {
    readonly public_websocket_url_ok: boolean;
    readonly normal_ws_ok: boolean;
    readonly forced_wrong_machine_replay_ok: boolean;
  };
}

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const requireFromSmokeBot = createRequire(
  pathToFileURL(join(resolve(process.cwd()), "testing", "smoke-bot", "package.json")),
);
const WebSocket = (await import(requireFromSmokeBot.resolve("ws"))).default;

await seedControlPlane(options);
const forcedHealthChecks = await forcedHealthByMachine(options);
const placement = await requestPlacement(options);
const placementUrl = new URL(placement.webSocketUrl);
const publicWebsocketUrlOk =
  placementUrl.protocol === "wss:" &&
  placementUrl.host === new URL(options.shardUrl).host &&
  placementUrl.pathname.startsWith("/gateway") &&
  placementUrl.searchParams.has("placementToken") &&
  !placementUrl.searchParams.has("fly-force-instance-id") &&
  !placementUrl.searchParams.has("fly-prefer-instance-id");

const sessions: SessionProof[] = [];
sessions.push(await openSession("normal", placement.webSocketUrl));

const wrongMachineId = pickWrongMachineId(placement, forcedHealthChecks);
if (!wrongMachineId) {
  throw new Error(
    `could not pick non-target machine for replay proof; target=${placement.flyMachineId ?? "<missing>"}`,
  );
}
sessions.push(
  await openSession("forced-wrong-machine", placement.webSocketUrl, wrongMachineId),
);

const proof: WsRoutingProof = {
  schema_version: 1,
  kind: "fly-ws-routing-proof",
  started_at: startedAt,
  router_url: options.routerUrl,
  shard_url: options.shardUrl,
  game_id: options.gameId,
  player_id: options.playerId,
  bundle_name: options.bundleName,
  placement: {
    shard_id: placement.shardId,
    fly_machine_id: placement.flyMachineId,
    shard_url: placement.shardUrl,
    websocket_host: placementUrl.host,
    websocket_path: placementUrl.pathname,
    has_placement_token: placementUrl.searchParams.has("placementToken"),
    has_instance_query_params:
      placementUrl.searchParams.has("fly-force-instance-id") ||
      placementUrl.searchParams.has("fly-prefer-instance-id"),
    trace_id: placement.traceId,
  },
  forced_health_checks: forcedHealthChecks,
  sessions,
  summary: {
    public_websocket_url_ok: publicWebsocketUrlOk,
    normal_ws_ok: sessions.some((session) => session.mode === "normal" && session.readyOk),
    forced_wrong_machine_replay_ok: sessions.some(
      (session) => session.mode === "forced-wrong-machine" && session.readyOk,
    ),
  },
};

await mkdir(dirname(resolve(options.outputPath)), { recursive: true });
await writeFile(options.outputPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);

if (
  !proof.summary.public_websocket_url_ok ||
  !proof.summary.normal_ws_ok ||
  !proof.summary.forced_wrong_machine_replay_ok
) {
  process.exitCode = 2;
}

async function seedControlPlane(options: CliOptions): Promise<void> {
  const repoRoot = resolve(process.cwd());
  const source = await readFile(
    join(repoRoot, "examples", "bundles", options.bundleName, "dist", "bundle.js"),
    "utf8",
  );
  const manifest = await loadBundleManifest(repoRoot, options.bundleName);
  const bundleUrl = `${trimSlash(options.controlUrl)}/admin/bundles/${encodeURIComponent(options.bundleName)}`;
  const bundleLookup = await fetch(bundleUrl);
  if (bundleLookup.status === 404) {
    await requestJson(bundleUrl, {
      method: "POST",
      body: { manifest, source },
    });
  } else if (!bundleLookup.ok) {
    throw new Error(`bundle lookup failed: HTTP ${bundleLookup.status} ${await bundleLookup.text()}`);
  }

  await requestJson(`${trimSlash(options.controlUrl)}/admin/games`, {
    method: "POST",
    body: gameCreateBody(options),
  });
}

async function requestJson(
  url: string,
  init: { readonly method: "POST"; readonly body: unknown },
): Promise<unknown> {
  const response = await fetch(url, {
    method: init.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(init.body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}: ${text}`);
  return text.length > 0 ? JSON.parse(text) : {};
}

interface GameCreateBody {
  readonly gameId: string;
  readonly bundleName: string;
  readonly allowedPlayers: readonly string[];
}

function gameCreateBody(options: CliOptions): GameCreateBody {
  return {
    gameId: options.gameId,
    bundleName: options.bundleName,
    allowedPlayers: [options.playerId],
  };
}

async function loadBundleManifest(repoRoot: string, bundleName: string): Promise<BundleManifest> {
  const sourceModulePath = join(repoRoot, "examples", "bundles", bundleName, "src", "index.mts");
  const mod = (await import(pathToFileURL(sourceModulePath).href)) as BundleModule;
  const manifest = mod.default?.manifest;
  if (!manifest) throw new Error(`bundle ${bundleName} source did not export a manifest`);
  return manifest;
}

async function forcedHealthByMachine(
  options: CliOptions,
): Promise<Readonly<Record<string, HealthResponse>>> {
  const entries: Array<[string, HealthResponse]> = [];
  for (const machineId of options.machineIds) {
    const response = await fetch(`${trimSlash(options.shardUrl)}/healthz`, {
      headers: { "fly-force-instance-id": machineId },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`forced health ${machineId}: HTTP ${response.status} ${text}`);
    entries.push([machineId, JSON.parse(text) as HealthResponse]);
  }
  return Object.fromEntries(entries);
}

async function requestPlacement(options: CliOptions): Promise<PlacementResponse> {
  const response = await fetch(`${trimSlash(options.routerUrl)}/placement`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      gameId: options.gameId,
      playerId: options.playerId,
      runId: `phase9-ws-routing-${Date.now().toString(36)}`,
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`placement failed: HTTP ${response.status} ${text}`);
  return JSON.parse(text) as PlacementResponse;
}

function pickWrongMachineId(
  placement: PlacementResponse,
  healthChecks: Readonly<Record<string, HealthResponse>>,
): string | undefined {
  for (const [machineId, health] of Object.entries(healthChecks)) {
    if (machineId === placement.flyMachineId) continue;
    if (health.shardId && health.shardId !== placement.shardId) return machineId;
  }
  return undefined;
}

function openSession(
  mode: SessionProof["mode"],
  webSocketUrl: string,
  forcedMachineId?: string,
): Promise<SessionProof> {
  const headers = forcedMachineId ? { "fly-force-instance-id": forcedMachineId } : undefined;
  const ws = new WebSocket(webSocketUrl, { headers });
  return new Promise<SessionProof>((resolveSession, rejectSession) => {
    const timeout = setTimeout(() => {
      cleanup();
      rejectSession(new Error(`${mode} websocket timed out waiting for ready`));
    }, 20_000);
    function cleanup(): void {
      clearTimeout(timeout);
      ws.removeAllListeners();
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, `${mode} proof done`);
    }

    ws.once("error", (err) => {
      cleanup();
      rejectSession(err);
    });
    ws.once("unexpected-response", (_request, response) => {
      cleanup();
      rejectSession(
        new Error(`${mode} websocket unexpected HTTP ${response.statusCode ?? "<unknown>"}`),
      );
    });
    ws.once("close", (code, reason) => {
      cleanup();
      rejectSession(
        new Error(`${mode} websocket closed before ready: ${code} ${reason.toString()}`.trim()),
      );
    });
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as ReadyFrame;
      if (frame.type === "ready") {
        const proof: SessionProof = {
          mode,
          forcedMachineId,
          readyOk: true,
          readySessionId: frame.sessionId,
        };
        cleanup();
        resolveSession(proof);
      }
    });
  });
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) throw new Error(`unexpected positional argument: ${arg ?? ""}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg.slice(2), value);
    i += 1;
  }
  const machineIds = (values.get("machine-ids") ?? process.env["PAX_SHARD_MACHINE_IDS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (machineIds.length < 2) throw new Error("--machine-ids must include at least two IDs");
  const controlUrl = values.get("control-url") ?? process.env["PAX_CONTROL_URL"] ?? "";
  if (!controlUrl) throw new Error("--control-url or PAX_CONTROL_URL is required");
  return {
    routerUrl: values.get("router-url") ?? process.env["PAX_ROUTER_URL"] ?? "https://pax-backend-control.fly.dev",
    shardUrl: values.get("shard-url") ?? process.env["PAX_SHARD_URL"] ?? "https://pax-backend-shards.fly.dev",
    controlUrl,
    machineIds,
    gameId: values.get("game-id") ?? `phase9-ws-${Date.now().toString(36)}`,
    playerId: values.get("player-id") ?? "phase9-player",
    bundleName: values.get("bundle") ?? "hello-ws-echo",
    outputPath: values.get("output") ?? "var/phase-9/ws-routing-proof.json",
  };
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
