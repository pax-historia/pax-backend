import { createHash, randomUUID } from "node:crypto";

import {
  GATEWAY_ENVELOPE_VERSION,
  type ApiGatewayDispatchInput,
  type GatewayHttpRequestBody,
} from "@pax-backend/ipc-protocol";

export interface BuiltGatewayEnvelope {
  readonly requestId: string;
  readonly body: GatewayHttpRequestBody;
  readonly rawOutbound: string;
  readonly fingerprint: string;
  readonly headers: Readonly<Record<string, string>>;
}

export function buildGatewayEnvelope(
  input: ApiGatewayDispatchInput,
  mode: "live" | "replay",
): BuiltGatewayEnvelope {
  const requestId = randomUUID();
  const traceId = isTraceId(input.traceId) ? input.traceId : null;
  const body: GatewayHttpRequestBody = {
    args: input.args,
    context: {
      gameId: input.gameId,
      traceId,
      triggeringSessionId: input.triggeringSessionId,
      triggeringJwtClaims: input.triggeringJwtClaims,
      connectedSessions: input.connectedSessions,
      bundleName: input.bundleName,
      bundleCompatTag: input.bundleCompatTag,
      runId: input.runId,
      idempotencyKey: input.idempotencyKey ?? null,
    },
  };
  const rawOutbound = stableSerialize(body);
  const rawFingerprint = stableSerialize({
    kind: input.kind,
    args: input.args,
  });
  return {
    requestId,
    body,
    rawOutbound,
    fingerprint: sha256Hex(rawFingerprint),
    headers: {
      "content-type": "application/json",
      "x-gateway-envelope-version": String(GATEWAY_ENVELOPE_VERSION),
      "x-gateway-request-id": requestId,
      "x-gateway-game-id": input.gameId,
      "x-gateway-kind": input.kind,
      "x-gateway-mode": mode,
      ...(input.runId === null ? {} : { "x-gateway-run-id": input.runId }),
      ...(traceId
        ? {
            traceparent: `00-${traceId}-${spanIdFromRequestId(requestId)}-01`,
            "x-gateway-trace-id": traceId,
          }
        : {}),
    },
  };
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function spanIdFromRequestId(requestId: string): string {
  return sha256Hex(requestId).slice(0, 16);
}

function isTraceId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) {
      out[key] = canonicalize(item);
    }
  }
  return out;
}
