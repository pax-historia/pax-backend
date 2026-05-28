export function readBodyType(body: Readonly<Record<string, unknown>>): string {
  const type = body["type"];
  return typeof type === "string" && type.length > 0 ? type : "unknown";
}

export function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
