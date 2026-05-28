import { createHash } from "node:crypto";

import type { ReferenceServiceResult } from "./types.mjs";

export function ok(result: unknown): ReferenceServiceResult {
  return {
    handled: true,
    statusCode: 200,
    body: { result },
  };
}

export function badRequest(message: string): ReferenceServiceResult {
  return {
    handled: true,
    statusCode: 400,
    body: { error: "badRequest", detail: { message } },
  };
}

export function isAllowedHttpFetchTarget(url: URL, allowlist: readonly string[]): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (allowlist.includes("*")) return true;
  return allowlist.some((entry) => {
    try {
      const parsed = new URL(entry.includes("://") ? entry : `https://${entry}`);
      return parsed.hostname === url.hostname && (parsed.port === "" || parsed.port === url.port);
    } catch {
      return entry === url.hostname || entry === url.origin;
    }
  });
}

export function stringifyHeaders(headers: Readonly<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

export function readObjectNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const item = value[key];
  return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function estimateTokenCount(value: unknown): number {
  return Math.max(1, Math.ceil(stableSerialize(value).length / 4));
}

export function stableSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "undefined";
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
