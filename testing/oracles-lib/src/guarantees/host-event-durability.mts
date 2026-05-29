import { booleanField, finding, numberField, result, stringField } from "../helpers.mjs";
import type { HistoryEvent, OracleFinding, OracleResult } from "../types.mjs";

const ORACLE = "host-event-durability";
const GUARANTEE = 17;

export function hostEventDurability(history: readonly HistoryEvent[]): OracleResult {
  const durableReceipts = new Map<string, HistoryEvent[]>();
  const delivered = new Map<string, HistoryEvent[]>();
  const findings: OracleFinding[] = [];
  let observed = 0;

  for (const event of history) {
    if (event.event !== "onHostEvent.received" && event.event !== "onHostEvent.delivered") {
      continue;
    }
    observed += 1;
    const gameId = stringField(event, "gameId");
    const eventType = stringField(event, "eventType");
    if (!gameId || !eventType) {
      findings.push(
        finding("missing-fields", `${event.event} must include gameId and eventType`, event),
      );
      continue;
    }
    const key = hostEventKey(event, gameId, eventType);
    if (event.event === "onHostEvent.received") {
      if (booleanField(event, "wakeOnDelivery") === true) {
        const existing = durableReceipts.get(key) ?? [];
        durableReceipts.set(key, [...existing, event]);
      }
      continue;
    }

    const attempts = numberField(event, "deliveryAttempts");
    if (attempts !== undefined && (!Number.isInteger(attempts) || attempts < 1)) {
      findings.push(
        finding(
          "invalid-delivery-attempts",
          "onHostEvent.delivered deliveryAttempts must be an integer >= 1",
          event,
        ),
      );
    }
    const existing = delivered.get(key) ?? [];
    delivered.set(key, [...existing, event]);
  }

  for (const [key, receipts] of durableReceipts.entries()) {
    if ((delivered.get(key) ?? []).length === 0) {
      for (const receipt of receipts) {
        findings.push(
          finding(
            "durable-host-event-not-delivered",
            "wakeOnDelivery host event was received but no matching delivery was observed",
            receipt,
            { key },
          ),
        );
      }
    }
  }

  return result(ORACLE, GUARANTEE, history, Math.max(observed, history.length), findings);
}

function hostEventKey(event: HistoryEvent, gameId: string, eventType: string): string {
  const eventId = stringField(event, "eventId");
  if (eventId) return `${gameId}\0${eventType}\0${eventId}`;
  return `${gameId}\0${eventType}\0${stableFingerprint(event["payload"])}`;
}

function stableFingerprint(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}
