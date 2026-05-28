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
      if (sha256Hex(rawOutbound) !== fingerprint) {
        findings.push(
          finding("fingerprint-mismatch", "api.invoke.wire fingerprint did not match rawOutbound", event),
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

  return result(ORACLE, GUARANTEE, history, observed, findings);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
