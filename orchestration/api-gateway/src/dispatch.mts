import {
  type ApiGatewayDispatchInput,
  type ApiGatewayInvokeResult,
  type ApiInvokeError,
  type ApiInvokeResponse,
  type ApiInvokeWireRecord,
  type GatewayHttpResponseBody,
} from "@pax-backend/ipc-protocol";
import { withPaxSpan } from "@pax-backend/node-telemetry";

import type { ApiInvocationBudget } from "./budgets.mjs";
import { buildGatewayEnvelope, stableSerialize } from "./envelope.mjs";
import type { ApiKindRegistry } from "./registry.mjs";
import type { WireRecordStore } from "./record-replay.mjs";

export interface ApiGatewayOptions {
  readonly registry: ApiKindRegistry;
  readonly budget: ApiInvocationBudget;
  readonly records: WireRecordStore;
  readonly defaultMode: "live" | "replay";
  readonly providerTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface ApiGatewayMetricsSnapshot {
  readonly invocationsTotal: number;
  readonly okTotal: number;
  readonly errorsTotal: Readonly<Record<ApiInvokeError, number>>;
}

export class ApiGateway {
  readonly #registry: ApiKindRegistry;
  readonly #budget: ApiInvocationBudget;
  readonly #records: WireRecordStore;
  readonly #defaultMode: "live" | "replay";
  readonly #fetch: typeof fetch;
  readonly #providerTimeoutMs: number;
  #invocationsTotal = 0;
  #okTotal = 0;
  readonly #errorsTotal = new Map<ApiInvokeError, number>();

  constructor(options: ApiGatewayOptions) {
    this.#registry = options.registry;
    this.#budget = options.budget;
    this.#records = options.records;
    this.#defaultMode = options.defaultMode;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#providerTimeoutMs = options.providerTimeoutMs ?? 30_000;
  }

  metricsSnapshot(): ApiGatewayMetricsSnapshot {
    return {
      invocationsTotal: this.#invocationsTotal,
      okTotal: this.#okTotal,
      errorsTotal: {
        kindUnknown: this.#errorsTotal.get("kindUnknown") ?? 0,
        providerError: this.#errorsTotal.get("providerError") ?? 0,
        apiRateExceeded: this.#errorsTotal.get("apiRateExceeded") ?? 0,
        replayCoverageGap: this.#errorsTotal.get("replayCoverageGap") ?? 0,
      },
    };
  }

  async invoke(input: ApiGatewayDispatchInput): Promise<ApiGatewayInvokeResult> {
    return withPaxSpan(
      "gateway.invoke",
      {
        kind: input.kind,
        mode: input.replayMode === true ? "replay" : this.#defaultMode,
        game_id: input.gameId,
        run_id: input.runId,
        bundle_name: input.bundleName,
        bundle_compat_tag: input.bundleCompatTag,
      },
      async (span) => {
        const result = await this.#invokeWithMetrics(input);
        span.setAttribute("result", result.response.ok ? "ok" : result.response.error);
        if (result.wireRecord) {
          span.setAttribute("http.response.status_code", result.wireRecord.statusCode);
        }
        return result;
      },
    );
  }

  async #invokeWithMetrics(input: ApiGatewayDispatchInput): Promise<ApiGatewayInvokeResult> {
    this.#invocationsTotal += 1;
    const mode = input.replayMode === true ? "replay" : this.#defaultMode;
    const envelope = buildGatewayEnvelope(input, mode);

    const budget = this.#budget.checkAndRecord(input.gameId);
    if (!budget.ok) {
      return this.#recordAndReturn(input, envelope, mode, 0, "apiRateExceeded", {
        currentUsage: budget.currentUsage,
        limit: budget.limit,
        windowMs: budget.windowMs,
      });
    }

    const url = await this.#registry.get(input.kind);
    if (!url) {
      return this.#recordAndReturn(input, envelope, mode, 0, "kindUnknown", {
        kind: input.kind,
      });
    }

    if (mode === "replay") {
      const recorded = await this.#records.lookup(envelope.fingerprint);
      if (!recorded) {
        return this.#recordAndReturn(input, envelope, mode, 0, "replayCoverageGap", {
          fingerprint: envelope.fingerprint,
        });
      }
      const record: ApiInvokeWireRecord = {
        ...recorded,
        event: "api.invoke",
        mode: "replay",
        requestId: envelope.requestId,
        kind: input.kind,
        gameId: input.gameId,
        runId: input.runId,
        rawOutbound: envelope.rawOutbound,
        rawInbound: recorded.rawInbound,
        statusCode: recorded.statusCode,
        error: recorded.error,
        recordedAt: new Date().toISOString(),
      };
      await this.#records.record(record);
      const response = apiInvokeResponseFromHttp(recorded.statusCode, recorded.rawInbound);
      this.#recordMetrics(response);
      return { response, wireRecord: record };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#providerTimeoutMs);
    timeout.unref();
    try {
      const res = await this.#fetch(url, {
        method: "POST",
        headers: envelope.headers,
        body: envelope.rawOutbound,
        signal: controller.signal,
      });
      const rawInbound = await res.text();
      const response = apiInvokeResponseFromHttp(res.status, rawInbound);
      const record: ApiInvokeWireRecord = {
        event: "api.invoke",
        requestId: envelope.requestId,
        fingerprint: envelope.fingerprint,
        mode,
        kind: input.kind,
        gameId: input.gameId,
        runId: input.runId,
        rawOutbound: envelope.rawOutbound,
        rawInbound,
        statusCode: res.status,
        error: response.ok ? undefined : response.error,
        recordedAt: new Date().toISOString(),
      };
      await this.#records.record(record);
      this.#recordMetrics(response);
      return { response, wireRecord: record };
    } catch (err) {
      return this.#recordAndReturn(input, envelope, mode, 0, "providerError", {
        timeoutMs: this.#providerTimeoutMs,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async #recordAndReturn(
    input: ApiGatewayDispatchInput,
    envelope: ReturnType<typeof buildGatewayEnvelope>,
    mode: "live" | "replay",
    statusCode: number,
    error: ApiInvokeError,
    detail: unknown,
  ): Promise<ApiGatewayInvokeResult> {
    const response: ApiInvokeResponse = { ok: false, error, detail };
    this.#recordMetrics(response);
    const record: ApiInvokeWireRecord = {
      event: "api.invoke",
      requestId: envelope.requestId,
      fingerprint: envelope.fingerprint,
      mode,
      kind: input.kind,
      gameId: input.gameId,
      runId: input.runId,
      rawOutbound: envelope.rawOutbound,
      rawInbound: stableSerialize(response),
      statusCode,
      error,
      recordedAt: new Date().toISOString(),
    };
    await this.#records.record(record);
    return { response, wireRecord: record };
  }

  #recordMetrics(response: ApiInvokeResponse): void {
    if (response.ok) {
      this.#okTotal += 1;
      return;
    }
    this.#errorsTotal.set(response.error, (this.#errorsTotal.get(response.error) ?? 0) + 1);
  }
}

export function apiInvokeResponseFromHttp(
  statusCode: number,
  rawInbound: string,
): ApiInvokeResponse {
  const parsed = parseJson(rawInbound);
  if (statusCode >= 200 && statusCode < 300) {
    if (isRecord(parsed) && Object.prototype.hasOwnProperty.call(parsed, "result")) {
      return { ok: true, result: (parsed as GatewayHttpResponseBody & { result: unknown }).result };
    }
    return {
      ok: false,
      error: "providerError",
      detail: { statusCode, rawInbound, message: "2xx response missing result" },
    };
  }
  return {
    ok: false,
    error: "providerError",
    detail: isRecord(parsed)
      ? parsed
      : { statusCode, rawInbound, message: "provider returned non-json error" },
  };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
