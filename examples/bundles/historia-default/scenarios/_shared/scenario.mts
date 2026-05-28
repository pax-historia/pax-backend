import type { ScenarioManifest, ScenarioWorkloadPlan } from "@pax-backend/scenario-runner";

export const HISTORIA_SUBSTRATE_ORACLES = [
  "singleton-game",
  "allowed-only-connection",
  "unique-stable-sessionid",
  "session-observability-accuracy",
  "faithful-api-dispatch",
  "idempotent-player-input",
  "compute-plane-quotas",
  "state-durability",
  "blob-durability",
  "history-completeness",
  "host-event-durability",
] as const;

export function makeManifest(
  scenarioId: string,
  description: string,
): ScenarioManifest {
  return {
    scenarioId,
    seed: `${scenarioId}-seed-v1`,
    determinism: "medium",
    defaultMode: "load",
    defaultBackend: "live",
    defaultNemesis: "no-faults",
    description,
    oracleNames: HISTORIA_SUBSTRATE_ORACLES,
  };
}

export function makeWorkload(input: {
  readonly scenarioId: string;
  readonly gameIdPrefix: string;
  readonly sessionsPerGame?: number;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly preMessageHostEvents?: readonly HostEventSpec[];
  readonly postMessageHostEvents?: readonly HostEventSpec[];
  readonly waitBeforePostHostEventsMs?: number;
}): ScenarioWorkloadPlan {
  return {
    scenarioId: input.scenarioId,
    bundleName: "historia-default",
    gameIdPrefix: input.gameIdPrefix,
    durationMs: 120_000,
    maxGames: 1,
    fixtures: [
      { kind: "allowed-players", path: "../_fixtures/allowed-players.json" },
      { kind: "initial-state", path: "../_fixtures/initial-state.json" },
      { kind: "initial-blob", path: "../_fixtures/initial-blob.json" },
    ],
    phases: [
      {
        type: "seed-fixtures",
        fixtureKinds: ["allowed-players", "initial-state", "initial-blob"],
      },
      {
        type: "register-api-kinds",
        kinds: [
          {
            kindName: "ai.chat.v1",
            url: "${apiGatewayUrl}/_url-services/mock-ai.v1/invoke",
          },
          {
            kindName: "flag.search.v1",
            url: "${apiGatewayUrl}/_url-services/echo/invoke",
          },
          {
            kindName: "moderation.audit.v1",
            url: "${apiGatewayUrl}/_url-services/echo/invoke",
          },
          {
            kindName: "participation.v1",
            url: "${apiGatewayUrl}/_url-services/echo/invoke",
          },
          {
            kindName: "projection.sync.v1",
            url: "${apiGatewayUrl}/_url-services/echo/invoke",
          },
        ],
      },
      {
        type: "open-sessions",
        playerSource: "allowed-players",
        sessionsPerGame: input.sessionsPerGame ?? 1,
        rampMs: 500,
      },
      ...hostEventPhases(input.preMessageHostEvents ?? []),
      ...hostEventDeliveryPhases(input.preMessageHostEvents ?? []),
      ...(input.body
        ? [
            {
              type: "send-json" as const,
              channel: "websocket" as const,
              messagesPerSession: 1,
              intervalMs: 0,
              body: input.body,
            },
          ]
        : []),
      ...(input.waitBeforePostHostEventsMs
        ? [{ type: "wait" as const, durationMs: input.waitBeforePostHostEventsMs }]
        : []),
      ...hostEventPhases(input.postMessageHostEvents ?? []),
      {
        type: "wait",
        durationMs: 500,
      },
      {
        type: "close-sessions",
        reason: "scenarioComplete",
      },
      {
        type: "expect-history-events",
        events: ["session.opened", "ws.send"],
        minimumPerGame: 1,
      },
    ],
  };
}

export interface HostEventSpec {
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly wakeOnDelivery?: boolean;
}

export function participant(playerId: string, entityId: string): HostEventSpec {
  return {
    eventType: "participationChanged",
    payload: {
      playerId,
      participant: true,
      entityId,
      changedBy: "host",
    },
  };
}

function hostEventPhases(events: readonly HostEventSpec[]): ScenarioWorkloadPlan["phases"] {
  return events.map((event) => ({
    type: "send-host-events" as const,
    eventType: event.eventType,
    payload: event.payload,
    wakeOnDelivery: event.wakeOnDelivery ?? false,
    targetGameCount: 1,
  }));
}

function hostEventDeliveryPhases(
  events: readonly HostEventSpec[],
): ScenarioWorkloadPlan["phases"] {
  return events.length > 0
    ? [
        {
          type: "expect-history-events" as const,
          events: ["onHostEvent.delivered"],
          minimumPerGame: events.length,
        },
      ]
    : [];
}
