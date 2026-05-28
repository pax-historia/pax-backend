import type { HistoryEvent } from "@pax-backend/oracles-lib";

import type {
  AttributionCandidate,
  ScenarioAttribution,
  ScenarioMetrics,
} from "./types.mjs";

interface MetricSample {
  readonly surface: string;
  readonly name: string;
  readonly value: number;
}

interface MetricSummary {
  readonly count: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
}

export function summarizeHistoryAttribution(history: readonly HistoryEvent[]): {
  readonly metrics: ScenarioMetrics;
  readonly attribution: ScenarioAttribution;
} {
  const samples = collectMetricSamples(history);
  const summaries = summarizeBySurface(samples);
  const candidates = rankCandidates(summaries);
  return {
    metrics: { per_surface: summaries },
    attribution: {
      sentence: attributionSentence(candidates),
      candidates,
      falsified: [],
    },
  };
}

function collectMetricSamples(history: readonly HistoryEvent[]): readonly MetricSample[] {
  const samples: MetricSample[] = [];
  for (const event of history) {
    if (event.event === "metrics.emit" && isRecord(event["payload"])) {
      const payload = event["payload"];
      const name = stringValue(payload["name"]);
      const value = numberValue(payload["value"]);
      if (name && value !== undefined) {
        samples.push({
          surface: inferSurface(name, payload["tags"]),
          name,
          value,
        });
      }
      continue;
    }

    if (event.event === "onCapacityWarning.sent") {
      const budget = stringValue(event["budget"]);
      const ratio = numberValue(event["ratio"]);
      if (budget && ratio !== undefined) {
        samples.push({
          surface: "parent",
          name: `compute.${budget}.usage_ratio`,
          value: ratio,
        });
      }
    }
  }
  return samples;
}

function summarizeBySurface(
  samples: readonly MetricSample[],
): Readonly<Record<string, Record<string, MetricSummary>>> {
  const grouped = new Map<string, Map<string, number[]>>();
  for (const sample of samples) {
    const byMetric = grouped.get(sample.surface) ?? new Map<string, number[]>();
    grouped.set(sample.surface, byMetric);
    const values = byMetric.get(sample.name) ?? [];
    values.push(sample.value);
    byMetric.set(sample.name, values);
  }

  const out: Record<string, Record<string, MetricSummary>> = {};
  for (const [surface, byMetric] of grouped.entries()) {
    const surfaceOut: Record<string, MetricSummary> = {};
    out[surface] = surfaceOut;
    for (const [metric, values] of byMetric.entries()) {
      surfaceOut[metric] = summarize(values);
    }
  }
  return out;
}

function summarize(values: readonly number[]): MetricSummary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function rankCandidates(
  summaries: Readonly<Record<string, Record<string, MetricSummary>>>,
): readonly AttributionCandidate[] {
  const ranked: Array<AttributionCandidate & { readonly max: number }> = [];
  for (const [surface, byMetric] of Object.entries(summaries)) {
    for (const [metric, summary] of Object.entries(byMetric)) {
      ranked.push({
        subsystem: `${surface}.${metric}`,
        metric,
        rank: 0,
        p99_ms: p99Ms(metric, summary.p99),
        note: `count=${summary.count} max=${round(summary.max)}`,
        max: summary.max,
      });
    }
  }
  return ranked
    .sort((a, b) => b.max - a.max || Number(b.p99_ms ?? 0) - Number(a.p99_ms ?? 0))
    .slice(0, 3)
    .map((candidate, index) => ({
      subsystem: candidate.subsystem,
      metric: candidate.metric,
      rank: index + 1,
      p99_ms: candidate.p99_ms,
      note: candidate.note,
    }));
}

function attributionSentence(candidates: readonly AttributionCandidate[]): string {
  const top = candidates[0];
  if (!top) {
    return "No numeric metric samples were present; attribution is limited to oracle results.";
  }
  const p99 = top.p99_ms === undefined ? "" : ` p99=${round(top.p99_ms)}ms`;
  return `Top replay metric candidate is ${top.subsystem} (${top.metric};${p99} ${top.note ?? ""}).`;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? 0;
}

function p99Ms(metric: string, value: number): number | undefined {
  if (metric.endsWith("_ms") || metric.endsWith(".ms")) return value;
  if (metric.endsWith("_seconds") || metric.endsWith(".seconds")) return value * 1_000;
  return undefined;
}

function inferSurface(name: string, tags: unknown): string {
  if (isRecord(tags) && typeof tags["surface"] === "string") {
    return tags["surface"];
  }
  const [prefix] = name.split(/[._-]/);
  return prefix && prefix.length > 0 ? prefix : "unknown";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
