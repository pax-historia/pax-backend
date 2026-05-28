import type { HistoryEvent, Oracle, OracleResult } from "@pax-backend/oracles-lib";

export function requireEventOracle(
  oracle: string,
  predicate: (event: HistoryEvent) => boolean,
): Oracle {
  return (history) => {
    const matches = history.filter(predicate);
    return result(oracle, matches.length > 0 ? "pass" : "fail", history.length, matches.length);
  };
}

export function requireApiKindOracle(kind: string): Oracle {
  return requireEventOracle(`historia-api-${kind.replaceAll(".", "-")}`, (event) =>
    event.event === "api.invoke.request" && event.kind === kind,
  );
}

export function requireHostEventOracle(eventType: string): Oracle {
  return requireEventOracle(`historia-host-${eventType}`, (event) =>
    event.event === "onHostEvent.delivered" && event.eventType === eventType,
  );
}

export function requireWsSendOracle(name: string): Oracle {
  return requireEventOracle(`historia-ws-${name}`, (event) => event.event === "ws.send");
}

function result(
  oracle: string,
  status: OracleResult["status"],
  checkedEvents: number,
  matches: number,
): OracleResult {
  return {
    oracle,
    guarantee: 0,
    status,
    checkedEvents,
    findings: status === "pass"
      ? []
      : [{ code: "missing-event", message: `${oracle} found ${matches} matching events` }],
  };
}
