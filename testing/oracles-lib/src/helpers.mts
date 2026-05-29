import { closeSync, openSync, readSync } from "node:fs";

import type { HistoryEvent, OracleFinding, OracleResult } from "./types.mjs";

export function readHistoryJsonl(path: string): readonly HistoryEvent[] {
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const events: HistoryEvent[] = [];
  let carry = "";
  let lineNumber = 0;
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      carry += buffer.toString("utf8", 0, bytesRead);
      let newlineIndex = carry.indexOf("\n");
      while (newlineIndex >= 0) {
        lineNumber += 1;
        parseHistoryLine(carry.slice(0, newlineIndex), lineNumber, events);
        carry = carry.slice(newlineIndex + 1);
        newlineIndex = carry.indexOf("\n");
      }
    }
    if (carry.trim().length > 0) {
      lineNumber += 1;
      parseHistoryLine(carry, lineNumber, events);
    }
    return events;
  } finally {
    closeSync(fd);
  }
}

export function parseHistoryJsonl(raw: string): readonly HistoryEvent[] {
  const events: HistoryEvent[] = [];
  const lines = raw.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    const parsed = JSON.parse(line) as unknown;
    if (!isRecord(parsed) || typeof parsed["event"] !== "string") {
      throw new Error(`history line ${index + 1} is not a history event`);
    }
    events.push(parsed as HistoryEvent);
  }
  return events;
}

function parseHistoryLine(line: string, lineNumber: number, events: HistoryEvent[]): void {
  if (line.trim().length === 0) return;
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed) || typeof parsed["event"] !== "string") {
    throw new Error(`history line ${lineNumber} is not a history event`);
  }
  events.push(parsed as HistoryEvent);
}

export function result(
  oracle: string,
  guarantee: number,
  history: readonly HistoryEvent[],
  observedEvents: number,
  findings: readonly OracleFinding[],
): OracleResult {
  return {
    oracle,
    guarantee,
    checkedEvents: history.length,
    status: findings.length > 0 ? "fail" : observedEvents > 0 ? "pass" : "inconclusive",
    findings,
  };
}

export function finding(
  code: string,
  message: string,
  event?: HistoryEvent,
  detail?: unknown,
): OracleFinding {
  return { code, message, event, detail };
}

export function stringField(event: HistoryEvent, key: string): string | undefined {
  const value = event[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberField(event: HistoryEvent, key: string): number | undefined {
  const value = event[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function booleanField(event: HistoryEvent, key: string): boolean | undefined {
  const value = event[key];
  return typeof value === "boolean" ? value : undefined;
}

export function requiredStringFindings(
  event: HistoryEvent,
  fields: readonly string[],
): readonly OracleFinding[] {
  return fields.flatMap((field) =>
    stringField(event, field)
      ? []
      : [
          finding(
            "missing-field",
            `${event.event} is missing required string field ${field}`,
            event,
            { field },
          ),
        ],
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
