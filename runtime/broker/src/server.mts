import type { Server } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Redis } from "ioredis";
import pino from "pino";
import { WebSocketServer } from "ws";

import { startPaxNodeTelemetry } from "@pax-backend/node-telemetry";
import { RunnerPool, spawnRunnerChildProcess, type RunnerKind } from "@pax-backend/runner";
import { LocalStateObjectStore, S3StateObjectStore, StateStore } from "@pax-backend/state-store";

import {
  Broker,
  createBrokerAdminServer,
  HttpApiGatewayClient,
  JsonlHistoryWriter,
  LocalBundleSourceStore,
  RedisAllowedPlayers,
  RedisBrokerDirectory,
  RedisBundleResolver,
  RedisHostEventQueue,
  S3BundleSourceStore,
} from "./index.mjs";

export interface BrokerRuntime {
  readonly broker: Broker;
  readonly server: Server;
  readonly redis: Redis;
  stop(): Promise<void>;
}

export async function startBrokerRuntimeFromEnv(env = process.env): Promise<BrokerRuntime> {
  startPaxNodeTelemetry({ serviceName: "pax-broker", paxZone: "runtime" });

  const bind = parseBind(env["PAX_BROKER_BIND"] ?? "0.0.0.0:7700");
  const publicUrl = env["PAX_SHARD_PUBLIC_URL"] ?? `http://${bind.host}:${bind.port}`;
  const shardId = env["PAX_SHARD_ID"] ?? env["FLY_MACHINE_ID"] ?? "shard-local";
  const redis = new Redis(env["REDIS_URL"] ?? "redis://127.0.0.1:6379", {
    lazyConnect: false,
    maxRetriesPerRequest: null,
  });
  const logger = pino({ name: "pax-broker", level: env["PAX_LOG_LEVEL"] ?? "info" });
  let broker: Broker | undefined;

  const runners = new RunnerPool(
    Array.from({ length: parsePositiveInteger(env["PAX_RUNNER_PROCESS_COUNT"] ?? "1", 1) }, (_value, index) =>
      spawnRunnerChildProcess({
        id: `${shardId}-runner-${index + 1}`,
        kind: parseRunnerKind(env["PAX_RUNNER_KIND"] ?? "ivm"),
        modulePath: env["PAX_RUNNER_CHILD_MODULE"] ?? fileURLToPath(new URL("../../runner/src/child-process.mts", import.meta.url)),
        execArgv: parseExecArgv(env["PAX_RUNNER_CHILD_EXEC_ARGV"]),
        maxAssignedGames: parsePositiveInteger(env["PAX_RUNNER_MAX_ASSIGNED_GAMES"] ?? "128", 128),
        defaultHandlerTimeoutMs: parsePositiveInteger(env["PAX_HANDLER_TIMEOUT_MS"] ?? "1000", 1_000),
        onEnvelope: async (envelope, runner) => {
          if (!broker) throw new Error("Broker received Runner envelope before startup completed");
          await broker.handleRunnerEnvelope(runner.id, envelope);
        },
      }),
    ),
  );

  const stateStore = new StateStore(stateObjectStoreFromEnv(env), {
    retainCheckpoints: parseNonNegativeInteger(env["PAX_STATE_RETAIN_CHECKPOINTS"] ?? "0", 0),
    enableTimeTravel: env["PAX_STATE_TIME_TRAVEL"] === "1",
  });
  const wsPath = env["PAX_BROKER_WS_PATH"] ?? "/gateway";
  broker = new Broker(
    {
      shardId,
      publicUrl,
      jwtSecret: env["PAX_JWT_SECRET"] ?? "local-dev-secret",
      runtimeContractsSupported: parseRuntimeContracts(env["PAX_RUNTIME_CONTRACTS_SUPPORTED"]),
      capacity: {
        maxActiveGames: parsePositiveInteger(env["PAX_BROKER_MAX_ACTIVE_GAMES"] ?? "1000", 1_000),
        softWatermarkPct: parsePercent(env["PAX_BROKER_SOFT_WATERMARK_PCT"] ?? "0.75", 0.75),
        hardWatermarkPct: parsePercent(env["PAX_BROKER_HARD_WATERMARK_PCT"] ?? "0.95", 0.95),
      },
      defaultMemoryLimitMb: parsePositiveInteger(env["PAX_RUNNER_MEMORY_LIMIT_MB"] ?? "256", 256),
      handlerTimeoutMs: parsePositiveInteger(env["PAX_HANDLER_TIMEOUT_MS"] ?? "1000", 1_000),
    },
    {
      runners,
      stateStore,
      history: new JsonlHistoryWriter(env["PAX_HISTORY_PATH"] ?? "var/history.jsonl"),
      directory: new RedisBrokerDirectory(redis, {
        flyMachineId: env["FLY_MACHINE_ID"],
        wsPath,
      }),
      allowedPlayers: new RedisAllowedPlayers(redis),
      gateway: new HttpApiGatewayClient(env["PAX_API_GATEWAY_URL"] ?? "http://127.0.0.1:9081/invoke"),
      hostEvents: new RedisHostEventQueue(redis),
      bundles: new RedisBundleResolver(redis, bundleSourceStoreFromEnv(env)),
      logger,
    },
  );
  await broker.start();

  const server = createBrokerAdminServer(broker);
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", publicUrl);
    if (!url.pathname.startsWith(wsPath)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void broker!.acceptWebSocket(ws, req.url ?? "/").catch((err) => {
        logger.warn({ err }, "websocket accept failed");
        ws.close(1011, "broker accept failed");
      });
    });
  });

  await new Promise<void>((resolveListen) => {
    server.listen(bind.port, bind.host, resolveListen);
  });
  logger.info({ bind, publicUrl, shardId, wsPath }, "Broker runtime listening");

  return {
    broker,
    server,
    redis,
    stop: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      wss.close();
      await broker!.stop();
      await runners.stop();
      redis.disconnect();
    },
  };
}

function stateObjectStoreFromEnv(env: NodeJS.ProcessEnv): LocalStateObjectStore | S3StateObjectStore {
  const bucket = env["BUCKET_NAME"] ?? env["PAX_TIGRIS_BUCKET"];
  if (bucket) {
    return new S3StateObjectStore({
      bucket,
      prefix: env["PAX_STATE_OBJECT_PREFIX"] ?? "state-runtime/",
      region: env["AWS_REGION"] ?? "auto",
      endpoint: env["AWS_ENDPOINT_URL_S3"],
    });
  }
  return new LocalStateObjectStore(env["PAX_LOCAL_TIGRIS_DIR"] ?? "var/tigris-local");
}

function bundleSourceStoreFromEnv(env: NodeJS.ProcessEnv): LocalBundleSourceStore | S3BundleSourceStore {
  const bucket = env["BUCKET_NAME"] ?? env["PAX_TIGRIS_BUCKET"];
  if (bucket) {
    return new S3BundleSourceStore({
      bucket,
      region: env["AWS_REGION"] ?? "auto",
      endpoint: env["AWS_ENDPOINT_URL_S3"],
    });
  }
  return new LocalBundleSourceStore(env["PAX_LOCAL_TIGRIS_DIR"] ?? "var/tigris-local");
}

function parseBind(value: string): { readonly host: string; readonly port: number } {
  const [host, rawPort] = value.includes(":") ? value.split(":") : ["0.0.0.0", value];
  const port = Number.parseInt(rawPort ?? "", 10);
  if (!host || !Number.isFinite(port) || port <= 0) {
    throw new Error(`invalid bind address: ${value}`);
  }
  return { host, port };
}

function parseRuntimeContracts(value: string | undefined): readonly [number, number] {
  if (!value) return [1, 1];
  const [rawMin, rawMax] = value.split(",");
  const min = Number.parseInt(rawMin ?? "", 10);
  const max = Number.parseInt(rawMax ?? rawMin ?? "", 10);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) {
    throw new Error(`invalid PAX_RUNTIME_CONTRACTS_SUPPORTED: ${value}`);
  }
  return [min, max];
}

function parseRunnerKind(value: string): RunnerKind {
  return value === "noivm" ? "noivm" : "ivm";
}

function parsePositiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePercent(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

function parseExecArgv(value: string | undefined): readonly string[] {
  if (value === undefined) return ["--import", "tsx"];
  return value.split(/\s+/).filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBrokerRuntimeFromEnv().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
