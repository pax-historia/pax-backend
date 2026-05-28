import { createHash } from "node:crypto";

import { booleanField, finding, numberField, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "faithful-api-dispatch";
const GUARANTEE = 5;
const API_ERRORS = new Set(["kindUnknown", "providerError", "apiRateExceeded", "replayCoverageGap"]);

export function faithfulApiDispatch(history: readonly HistoryEvent[]): OracleResult {
  const requests = new Map<string, HistoryEvent>();
  const responses = new Set<string>();
  const wires = new Map<string, HistoryEvent>();
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event === "api.invoke.request") {
      observed += 1;
      const requestId = stringField(event, "requestId");
      if (!requestId) {
        findings.push(finding("missing-requestid", "api.invoke.request must include requestId", event));
        continue;
      }
      requests.set(requestId, event);
      continue;
    }

    if (event.event === "api.invoke.response") {
      const requestId = stringField(event, "requestId");
      if (!requestId) {
        findings.push(finding("missing-requestid", "api.invoke.response must include requestId", event));
        continue;
      }
      responses.add(requestId);
      if (!requests.has(requestId)) {
        findings.push(
          finding("response-without-request", "api.invoke.response had no matching request", event),
        );
      }
      if (booleanField(event, "ok") === false) {
        const error = stringField(event, "error");
        if (!error || !API_ERRORS.has(error)) {
          findings.push(finding("untyped-api-error", "api.invoke.response used an unknown error", event));
        }
      }
      continue;
    }

    if (event.event === "api.invoke.wire") {
      observed += 1;
      const requestId = stringField(event, "requestId");
      if (!requestId) {
        findings.push(finding("missing-requestid", "api.invoke.wire must include requestId", event));
        continue;
      }
      wires.set(requestId, event);
      if (!requests.has(requestId)) {
        findings.push(finding("wire-without-request", "api.invoke.wire had no matching request", event));
      }
      const rawOutbound = stringField(event, "rawOutbound");
      const rawInbound = stringField(event, "rawInbound");
      const fingerprint = stringField(event, "fingerprint");
      const statusCode = numberField(event, "statusCode");
      if (!rawOutbound || !rawInbound || !fingerprint || statusCode === undefined) {
        findings.push(
          finding(
            "incomplete-wire-record",
            "api.invoke.wire must include fingerprint, statusCode, rawOutbound, and rawInbound",
            event,
          ),
        );
        continue;
      }
      const replayKey = replayKeyFromWire(event, rawOutbound);
      if (replayKey && sha256Hex(replayKey) !== fingerprint) {
        findings.push(
          finding(
            "fingerprint-mismatch",
            "api.invoke.wire fingerprint did not match replay key",
            event,
          ),
        );
      }
      if (!isJson(rawOutbound)) {
        findings.push(finding("wire-outbound-non-json", "api.invoke.wire rawOutbound must be JSON", event));
      }
    }
  }

  for (const requestId of requests.keys()) {
    if (!responses.has(requestId)) {
      findings.push(
        finding("request-without-response", "api.invoke.request had no matching response", undefined, {
          requestId,
        }),
      );
    }
  }
  for (const requestId of responses.keys()) {
    if (!wires.has(requestId)) {
      findings.push(
        finding("response-without-wire-record", "api.invoke.response had no wire-grain record", undefined, {
          requestId,
        }),
      );
    }
  }

  return result(ORACLE, GUARANTEE, history, Math.max(observed, history.length), findings);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function replayKeyFromWire(event: HistoryEvent, rawOutbound: string): string | undefined {
  const kind = stringField(event, "kind");
  if (!kind) return undefined;
  const outbound = parseJson(rawOutbound);
  if (!isRecord(outbound)) return undefined;
  return stableSerialize({ kind, args: outbound["args"] ?? {} });
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) out[key] = canonicalize(item);
  }
  return out;
}

function isJson(value: string): boolean {
  return parseJson(value) !== undefined;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
