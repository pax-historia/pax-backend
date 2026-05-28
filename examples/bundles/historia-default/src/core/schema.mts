import { HISTORIA_COMPAT_TAGS } from "../../manifest.js";

export type HistoriaCompatTag = (typeof HISTORIA_COMPAT_TAGS)[number];

export type HistoriaGameStatus = "lobby" | "in-progress" | "ended";

export interface WorkflowOverride {
  readonly code: string;
  readonly entryPoints: Readonly<Record<string, string>>;
}

export interface WorkflowOverrides {
  readonly chat?: WorkflowOverride;
  readonly advisor?: WorkflowOverride;
  readonly actions?: WorkflowOverride;
  readonly jumpForward?: WorkflowOverride;
  readonly moderation?: WorkflowOverride;
}

export interface WorkingEvent {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly at: number;
}

export interface HistoriaWorkingState {
  readonly version: 1;
  readonly updatedAt: number;
  readonly currentRoundDeltas: readonly WorkingEvent[];
  readonly readyPlayerIds: readonly string[];
  readonly inFlightTaskIds: readonly string[];
}

export interface HistoriaPlayerRecord {
  readonly playerId: string;
  readonly participant: boolean;
  readonly entityId?: string;
  readonly lastChangedAt: number;
}

export interface HistoriaBlobV5 {
  readonly schemaVersion: 5;
  readonly compatTag: "historia:v5";
  readonly updatedAt: number;
  readonly game: {
    readonly status: HistoriaGameStatus;
    readonly title?: string;
    readonly currentRound: number;
    readonly players: Readonly<Record<string, HistoriaPlayerRecord>>;
  };
  readonly chapters: readonly unknown[];
  readonly moderationSnapshots: Readonly<Record<string, unknown>>;
  readonly workflows?: WorkflowOverrides;
  readonly migration?: {
    readonly fromCompatTag: HistoriaCompatTag;
    readonly migratedAt: number;
  };
}

export function isHistoriaCompatTag(value: unknown): value is HistoriaCompatTag {
  return typeof value === "string" && HISTORIA_COMPAT_TAGS.includes(value as HistoriaCompatTag);
}

export function emptyWorkingState(now: number): HistoriaWorkingState {
  return {
    version: 1,
    updatedAt: now,
    currentRoundDeltas: [],
    readyPlayerIds: [],
    inFlightTaskIds: [],
  };
}

export function emptyBlob(now: number): HistoriaBlobV5 {
  return {
    schemaVersion: 5,
    compatTag: "historia:v5",
    updatedAt: now,
    game: {
      status: "lobby",
      currentRound: 1,
      players: {},
    },
    chapters: [],
    moderationSnapshots: {},
  };
}

export function normalizeWorkingState(value: unknown, now: number): HistoriaWorkingState {
  if (!isRecord(value) || value["version"] !== 1) return emptyWorkingState(now);
  return {
    version: 1,
    updatedAt: readNonNegativeNumber(value["updatedAt"], now),
    currentRoundDeltas: normalizeWorkingEvents(value["currentRoundDeltas"]),
    readyPlayerIds: readStringArray(value["readyPlayerIds"]),
    inFlightTaskIds: readStringArray(value["inFlightTaskIds"]),
  };
}

export function normalizeBlobV5(value: unknown, now: number): HistoriaBlobV5 {
  if (!isRecord(value)) return emptyBlob(now);
  const base = emptyBlob(now);
  const rawGame = isRecord(value["game"]) ? value["game"] : {};
  return {
    schemaVersion: 5,
    compatTag: "historia:v5",
    updatedAt: readNonNegativeNumber(value["updatedAt"], now),
    game: {
      status: readGameStatus(rawGame["status"], base.game.status),
      title: readOptionalString(rawGame["title"]),
      currentRound: readPositiveInt(rawGame["currentRound"], base.game.currentRound),
      players: normalizePlayers(rawGame["players"], now),
    },
    chapters: Array.isArray(value["chapters"]) ? value["chapters"] : [],
    moderationSnapshots: isRecord(value["moderationSnapshots"])
      ? value["moderationSnapshots"]
      : {},
    workflows: normalizeWorkflowOverrides(value["workflows"]),
    migration: normalizeMigration(value["migration"], now),
  };
}

function normalizeWorkingEvents(value: unknown): readonly WorkingEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = entry["id"];
    const type = entry["type"];
    if (typeof id !== "string" || typeof type !== "string") return [];
    return [
      {
        id,
        type,
        payload: entry["payload"],
        at: readNonNegativeNumber(entry["at"], 0),
      },
    ];
  });
}

function normalizePlayers(value: unknown, now: number): Readonly<Record<string, HistoriaPlayerRecord>> {
  if (!isRecord(value)) return {};
  const players: Record<string, HistoriaPlayerRecord> = {};
  for (const [playerId, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    players[playerId] = {
      playerId,
      participant: raw["participant"] === true,
      entityId: readOptionalString(raw["entityId"]),
      lastChangedAt: readNonNegativeNumber(raw["lastChangedAt"], now),
    };
  }
  return players;
}

function normalizeWorkflowOverrides(value: unknown): WorkflowOverrides | undefined {
  if (!isRecord(value)) return undefined;
  const overrides: Record<string, WorkflowOverride> = {};
  for (const key of ["chat", "advisor", "actions", "jumpForward", "moderation"]) {
    const raw = value[key];
    if (!isRecord(raw) || typeof raw["code"] !== "string" || !isRecord(raw["entryPoints"])) {
      continue;
    }
    const entryPoints: Record<string, string> = {};
    for (const [entryName, functionName] of Object.entries(raw["entryPoints"])) {
      if (typeof functionName === "string") entryPoints[entryName] = functionName;
    }
    overrides[key] = { code: raw["code"], entryPoints };
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function normalizeMigration(value: unknown, now: number): HistoriaBlobV5["migration"] {
  if (!isRecord(value) || !isHistoriaCompatTag(value["fromCompatTag"])) return undefined;
  return {
    fromCompatTag: value["fromCompatTag"],
    migratedAt: readNonNegativeNumber(value["migratedAt"], now),
  };
}

function readGameStatus(value: unknown, fallback: HistoriaGameStatus): HistoriaGameStatus {
  return value === "lobby" || value === "in-progress" || value === "ended" ? value : fallback;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readPositiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
