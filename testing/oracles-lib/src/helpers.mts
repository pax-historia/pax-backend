import { readFileSync } from "node:fs";

import type { HistoryEvent, OracleFinding, OracleResult } from "./types.mjs";

export function readHistoryJsonl(path: string): readonly HistoryEvent[] {
  return parseHistoryJsonl(readFileSync(path, "utf8"));
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
