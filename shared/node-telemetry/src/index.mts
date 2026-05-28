import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  SpanStatusCode,
  trace,
  type Span,
  type SpanAttributes,
} from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";

export interface PaxNodeTelemetryOptions {
  readonly serviceName: string;
  readonly paxZone: "runtime" | "orchestration" | "testing" | "vendor" | "local";
  readonly runtimeContract?: number | string;
}

export interface PaxNodeTelemetryHandle {
  readonly enabled: boolean;
  readonly serviceName: string;
  readonly endpoint?: string;
}

let sdk: NodeSDK | undefined;
let shutdownRegistered = false;

export function startPaxNodeTelemetry(options: PaxNodeTelemetryOptions): PaxNodeTelemetryHandle {
  if (sdk) {
    return {
      enabled: true,
      serviceName: options.serviceName,
      endpoint: traceEndpoint(),
    };
  }
  if (telemetryDisabled()) {
    return { enabled: false, serviceName: options.serviceName };
  }

  if (process.env["PAX_OTEL_DIAG"] === "debug") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  const endpoint = traceEndpoint();
  sdk = new NodeSDK({
    serviceName: options.serviceName,
    resource: resourceFromAttributes(resourceAttributes(options)),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });
  sdk.start();
  registerShutdown();

  return { enabled: true, serviceName: options.serviceName, endpoint };
}

export async function shutdownPaxNodeTelemetry(): Promise<void> {
  const active = sdk;
  sdk = undefined;
  await active?.shutdown();
}

export function paxTracer(name = "pax-backend") {
  return trace.getTracer(name);
}

export async function withPaxSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  return trace.getTracer("pax-backend").startActiveSpan(name, { attributes }, async (span) => {
    try {
      const value = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return value;
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

function telemetryDisabled(): boolean {
  return (
    process.env["PAX_OBSERVABILITY"] === "off" ||
    process.env["OTEL_SDK_DISABLED"] === "true" ||
    process.env["OTEL_TRACES_EXPORTER"] === "none"
  );
}

function traceEndpoint(): string {
  return (
    process.env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] ??
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??
    process.env["PAX_OTEL_EXPORTER_OTLP_ENDPOINT"] ??
    "http://127.0.0.1:4317"
  );
}

function resourceAttributes(
  options: PaxNodeTelemetryOptions,
): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    "service.name": options.serviceName,
    "service.namespace": "pax-backend",
    "deployment.environment.name": process.env["PAX_ENVIRONMENT"] ?? process.env["NODE_ENV"] ?? "development",
    "pax.zone": options.paxZone,
    "pax.runtime_contract": options.runtimeContract ?? process.env["PAX_RUNTIME_CONTRACT"] ?? "1",
  };
  setIfPresent(attrs, "pax.run_id", process.env["PAX_RUN_ID"]);
  setIfPresent(attrs, "fly.app", process.env["FLY_APP_NAME"]);
  setIfPresent(attrs, "fly.machine_id", process.env["FLY_MACHINE_ID"]);
  setIfPresent(attrs, "fly.region", process.env["FLY_REGION"]);
  return attrs;
}

function setIfPresent(
  attrs: Record<string, string | number | boolean>,
  key: string,
  value: string | undefined,
): void {
  if (value && value.length > 0) attrs[key] = value;
}

function registerShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const shutdown = (): void => {
    void shutdownPaxNodeTelemetry().catch((err: unknown) => {
      process.stderr.write(`failed to shut down OpenTelemetry SDK: ${String(err)}\n`);
    });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
