import {
  type ApiGatewayDispatchInput,
  type ApiInvokeError,
  type ApiInvokeResponse,
  type ApiInvokeWireRecord,
  type GatewayHttpResponseBody,
} from "@pax-backend/ipc-protocol";

import type { ApiInvocationBudget } from "./budgets.mjs";
import { buildGatewayEnvelope, stableSerialize } from "./envelope.mjs";
import type { ApiKindRegistry } from "./registry.mjs";
import type { WireRecordStore } from "./record-replay.mjs";

export interface ApiGatewayOptions {
  readonly registry: ApiKindRegistry;
  readonly budget: ApiInvocationBudget;
  readonly records: WireRecordStore;
  readonly defaultMode: "live" | "replay";
  readonly fetchImpl?: typeof fetch;
}

export class ApiGateway {
  readonly #registry: ApiKindRegistry;
  readonly #budget: ApiInvocationBudget;
  readonly #records: WireRecordStore;
  readonly #defaultMode: "live" | "replay";
  readonly #fetch: typeof fetch;

  constructor(options: ApiGatewayOptions) {
    this.#registry = options.registry;
    this.#budget = options.budget;
    this.#records = options.records;
    this.#defaultMode = options.defaultMode;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async invoke(input: ApiGatewayDispatchInput): Promise<ApiInvokeResponse> {
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
      await this.#records.record({
        ...recorded,
        mode: "replay",
        requestId: envelope.requestId,
        rawOutbound: envelope.rawOutbound,
        recordedAt: new Date().toISOString(),
      });
      return apiInvokeResponseFromHttp(recorded.statusCode, recorded.rawInbound);
    }

    try {
      const res = await this.#fetch(url, {
        method: "POST",
        headers: envelope.headers,
        body: envelope.rawOutbound,
      });
      const rawInbound = await res.text();
      const response = apiInvokeResponseFromHttp(res.status, rawInbound);
      await this.#records.record({
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
      });
      return response;
    } catch (err) {
      return this.#recordAndReturn(input, envelope, mode, 0, "providerError", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async #recordAndReturn(
    input: ApiGatewayDispatchInput,
    envelope: ReturnType<typeof buildGatewayEnvelope>,
    mode: "live" | "replay",
    statusCode: number,
    error: ApiInvokeError,
    detail: unknown,
  ): Promise<ApiInvokeResponse> {
    const response: ApiInvokeResponse = { ok: false, error, detail };
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
    return response;
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
