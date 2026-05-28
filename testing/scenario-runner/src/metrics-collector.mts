import type {
  AttributionCandidate,
  SamplingProfile,
  ScenarioAttribution,
  ScenarioMetrics,
  ScenarioRunnerInput,
} from "./types.mjs";

interface MetricEndpoint {
  readonly surface: string;
  readonly url: string;
}

interface PrometheusSample {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
}

interface ScrapedPrometheusSample extends PrometheusSample {
  readonly surface: string;
  readonly url: string;
  readonly sampledAtMs: number;
}

interface MetricScrapeError {
  readonly surface: string;
  readonly url: string;
  readonly sampled_at: string;
  readonly error: string;
}

interface MetricsCollectionResult {
  readonly metrics: ScenarioMetrics;
  readonly attribution: ScenarioAttribution;
}

interface ScalarSeriesSummary {
  readonly kind: "scalar";
  readonly series: number;
  readonly samples: number;
  readonly first: number;
  readonly last: number;
  readonly delta: number;
  readonly min: number;
  readonly p50: number;
  readonly p99: number;
  readonly max: number;
}

interface HistogramSummary {
  readonly kind: "histogram";
  readonly series: number;
  readonly samples: number;
  readonly count: number;
  readonly p50: number;
  readonly p99: number;
  readonly max_bucket: number;
}

type MetricSummary = ScalarSeriesSummary | HistogramSummary;

const DEFAULT_ROUTER_METRICS_URL = "http://127.0.0.1:9080/metrics";
const DEFAULT_CONTROL_METRICS_URL = "http://127.0.0.1:9070/metrics";
const DEFAULT_GATEWAY_METRICS_URL = "http://127.0.0.1:9081/metrics";
const DEFAULT_PARENT_METRICS_URL = "http://127.0.0.1:7700/metrics";
const DEFAULT_ENGINE_METRICS_URL = "http://127.0.0.1:6430/metrics";
const DEFAULT_SCRAPE_TIMEOUT_MS = 2_000;

export class ScenarioMetricsCollector {
  readonly #endpoints: readonly MetricEndpoint[];
  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  readonly #samplingProfile: SamplingProfile;
  readonly #accumulator = new MetricsAccumulator();
  readonly #errors: MetricScrapeError[] = [];
  #timer: NodeJS.Timeout | undefined;
  #startedAtMs = 0;
  #scrapeInFlight = false;

  constructor(
    input: ScenarioRunnerInput,
    samplingProfile: SamplingProfile,
  ) {
    this.#endpoints = metricEndpoints(input);
    this.#intervalMs = input.metricsScrapeIntervalMs ?? scrapeIntervalMs(samplingProfile);
    this.#timeoutMs = DEFAULT_SCRAPE_TIMEOUT_MS;
    this.#samplingProfile = samplingProfile;
  }

  async start(): Promise<void> {
    this.#startedAtMs = Date.now();
    await this.#scrapeAll();
    if (this.#intervalMs > 0) {
      this.#timer = setInterval(() => {
        void this.#scrapeAll();
      }, this.#intervalMs);
      this.#timer.unref();
    }
  }

  async stop(): Promise<MetricsCollectionResult> {
    if (this.#timer) clearInterval(this.#timer);
    await this.#scrapeAll();
    return summarizeAccumulatedMetrics(
      this.#accumulator,
      this.#errors,
      this.#startedAtMs,
      Date.now(),
      this.#intervalMs,
      this.#endpoints,
    );
  }

  async #scrapeAll(): Promise<void> {
    if (this.#scrapeInFlight) return;
    this.#scrapeInFlight = true;
    const sampledAtMs = Date.now();
    try {
      await Promise.all(
        this.#endpoints.map(async (endpoint) => {
          try {
            const text = await fetchPrometheusText(endpoint.url, this.#timeoutMs);
            for (const sample of parsePrometheusText(text)) {
              if (!metricAllowedForProfile(endpoint.surface, sample.name, this.#samplingProfile)) {
                this.#accumulator.droppedSampleCount += 1;
                continue;
              }
              this.#accumulator.observe({
                ...sample,
                surface: endpoint.surface,
                url: endpoint.url,
                sampledAtMs,
              });
            }
          } catch (err) {
            this.#errors.push({
              surface: endpoint.surface,
              url: endpoint.url,
              sampled_at: new Date(sampledAtMs).toISOString(),
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }),
      );
    } finally {
      this.#scrapeInFlight = false;
    }
  }
}

class MetricsAccumulator {
  readonly scalarSeries = new Map<string, ScalarSeriesAccumulator>();
  readonly histogramSeries = new Map<string, HistogramSeriesAccumulator>();
  sampleCount = 0;
  droppedSampleCount = 0;

  observe(sample: ScrapedPrometheusSample): void {
    this.sampleCount += 1;
    if (sample.name.endsWith("_bucket") && sample.labels["le"] !== undefined) {
      const family = sample.name.slice(0, -"_bucket".length);
      const bucket = parseLe(sample.labels["le"]);
      if (bucket === undefined) return;
      const key = metricKey(sample.surface, family, labelsKey(withoutLabel(sample.labels, "le")));
      const accumulator =
        this.histogramSeries.get(key) ??
        new HistogramSeriesAccumulator(sample.surface, family, parseMetricKey(key).labelKey);
      this.histogramSeries.set(key, accumulator);
      accumulator.observe(bucket, sample.value);
      return;
    }

    const key = metricKey(sample.surface, sample.name, labelsKey(sample.labels));
    const accumulator =
      this.scalarSeries.get(key) ??
      new ScalarSeriesAccumulator(sample.surface, sample.name, parseMetricKey(key).labelKey);
    this.scalarSeries.set(key, accumulator);
    accumulator.observe(sample.value);
  }
}

class ScalarSeriesAccumulator {
  readonly values: number[] = [];
  count = 0;
  first: number | undefined;
  last = 0;
  min = Number.POSITIVE_INFINITY;
  max = Number.NEGATIVE_INFINITY;

  constructor(
    readonly surface: string,
    readonly metric: string,
    readonly labelKey: string,
  ) {}

  observe(value: number): void {
    this.count += 1;
    this.first ??= value;
    this.last = value;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
    if (this.values.length < 2_048) {
      this.values.push(value);
    } else {
      this.values[this.count % this.values.length] = value;
    }
  }
}

class HistogramSeriesAccumulator {
  readonly buckets = new Map<number, number>();
  samples = 0;

  constructor(
    readonly surface: string,
    readonly metric: string,
    readonly labelKey: string,
  ) {}

  observe(bucket: number, value: number): void {
    this.samples += 1;
    this.buckets.set(bucket, value);
  }
}

export function parsePrometheusText(text: string): readonly PrometheusSample[] {
  const samples: PrometheusSample[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{([^}]*)\})?\s+(\S+)/.exec(line);
    if (!match) continue;
    const name = match[1];
    const rawValue = Number(match[3]);
    if (!name || !Number.isFinite(rawValue)) continue;
    samples.push({
      name,
      labels: parsePrometheusLabels(match[2] ?? ""),
      value: rawValue,
    });
  }
  return samples;
}

export function summarizeCollectedMetrics(
  samples: readonly ScrapedPrometheusSample[],
  errors: readonly MetricScrapeError[],
  startedAtMs: number,
  finishedAtMs: number,
  intervalMs: number,
  endpoints: readonly MetricEndpoint[],
): MetricsCollectionResult {
  const perSurface = summarizeBySurface(samples);
  const metrics: ScenarioMetrics = {
    per_surface: perSurface,
    scrape: {
      started_at: new Date(startedAtMs).toISOString(),
      finished_at: new Date(finishedAtMs).toISOString(),
      interval_ms: intervalMs,
      endpoints,
      sample_count: samples.length,
      error_count: errors.length,
      errors,
    },
  };
  const candidates = rankMetricCandidates(perSurface);
  return {
    metrics,
    attribution: {
      sentence: metricAttributionSentence(samples.length, errors.length, candidates),
      candidates,
      falsified: [],
    },
  };
}

function summarizeAccumulatedMetrics(
  accumulator: MetricsAccumulator,
  errors: readonly MetricScrapeError[],
  startedAtMs: number,
  finishedAtMs: number,
  intervalMs: number,
  endpoints: readonly MetricEndpoint[],
): MetricsCollectionResult {
  const perSurface = summarizeAccumulatorBySurface(accumulator);
  const metrics: ScenarioMetrics = {
    per_surface: perSurface,
    scrape: {
      started_at: new Date(startedAtMs).toISOString(),
      finished_at: new Date(finishedAtMs).toISOString(),
      interval_ms: intervalMs,
      endpoints,
      sample_count: accumulator.sampleCount,
      dropped_sample_count: accumulator.droppedSampleCount,
      error_count: errors.length,
      errors,
    },
  };
  const candidates = rankMetricCandidates(perSurface);
  return {
    metrics,
    attribution: {
      sentence: metricAttributionSentence(accumulator.sampleCount, errors.length, candidates),
      candidates,
      falsified: [],
    },
  };
}

export function hasPrometheusMetricSamples(metrics: ScenarioMetrics): boolean {
  return (metrics.scrape?.sample_count ?? 0) > 0;
}

function metricEndpoints(input: ScenarioRunnerInput): readonly MetricEndpoint[] {
  return [
    {
      surface: "router",
      url:
        process.env["PAX_ROUTER_METRICS_URL"] ??
        metricsUrl(input.routerUrl ?? process.env["PAX_ROUTER_URL"], DEFAULT_ROUTER_METRICS_URL),
    },
    {
      surface: "control",
      url:
        process.env["PAX_CONTROL_METRICS_URL"] ??
        metricsUrl(input.controlPlaneUrl ?? process.env["PAX_CONTROL_URL"], DEFAULT_CONTROL_METRICS_URL),
    },
    {
      surface: "gateway",
      url:
        process.env["PAX_GATEWAY_METRICS_URL"] ??
        metricsUrl(
          input.apiGatewayUrl ??
            process.env["PAX_SCENARIO_API_GATEWAY_URL"] ??
            process.env["PAX_API_GATEWAY_BASE_URL"] ??
            process.env["PAX_API_GATEWAY_URL"],
          DEFAULT_GATEWAY_METRICS_URL,
        ),
    },
    {
      surface: "parent",
      url: process.env["PAX_PARENT_METRICS_URL"] ?? DEFAULT_PARENT_METRICS_URL,
    },
    {
      surface: "engine",
      url: process.env["PAX_RIVET_METRICS_URL"] ?? DEFAULT_ENGINE_METRICS_URL,
    },
  ];
}

async function fetchPrometheusText(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function metricsUrl(baseUrl: string | undefined, fallback: string): string {
  if (!baseUrl) return fallback;
  const url = new URL(baseUrl);
  url.pathname = "/metrics";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function scrapeIntervalMs(profile: SamplingProfile): number {
  switch (profile) {
    case "cliff_hold":
      return 1_000;
    case "replay":
      return 0;
    case "ramp":
      return 30_000;
  }
}

function metricAllowedForProfile(
  surface: string,
  metric: string,
  profile: SamplingProfile,
): boolean {
  if (profile !== "cliff_hold" || surface !== "engine") return true;
  return FAST_ENGINE_METRIC_FAMILIES.some(
    (family) => metric === family || metric.startsWith(`${family}_`),
  );
}

const FAST_ENGINE_METRIC_FAMILIES = [
  "rivet_api_request_duration",
  "rivet_gasoline_worker_bumps_per_tick",
  "rivet_ups_bytes_per_message",
  "rivet_ups_ops_per_message",
  "rivet_workflow_tick_duration",
  "rivet_actor_active",
] as const;

function summarizeAccumulatorBySurface(
  accumulator: MetricsAccumulator,
): Readonly<Record<string, Record<string, MetricSummary>>> {
  const groupedScalars = new Map<string, Map<string, ScalarSeriesAccumulator[]>>();
  for (const series of accumulator.scalarSeries.values()) {
    const byMetric = groupedScalars.get(series.surface) ?? new Map();
    groupedScalars.set(series.surface, byMetric);
    byMetric.set(series.metric, [...(byMetric.get(series.metric) ?? []), series]);
  }

  const groupedHistograms = new Map<string, Map<string, HistogramSeriesAccumulator[]>>();
  for (const series of accumulator.histogramSeries.values()) {
    const byMetric = groupedHistograms.get(series.surface) ?? new Map();
    groupedHistograms.set(series.surface, byMetric);
    byMetric.set(series.metric, [...(byMetric.get(series.metric) ?? []), series]);
  }

  const out: Record<string, Record<string, MetricSummary>> = {};
  for (const [surface, byMetric] of groupedScalars.entries()) {
    const surfaceOut = out[surface] ?? {};
    out[surface] = surfaceOut;
    for (const [metric, series] of byMetric.entries()) {
      surfaceOut[metric] = summarizeScalarAccumulators(series);
    }
  }
  for (const [surface, byMetric] of groupedHistograms.entries()) {
    const surfaceOut = out[surface] ?? {};
    out[surface] = surfaceOut;
    for (const [metric, series] of byMetric.entries()) {
      surfaceOut[metric] = summarizeHistogramAccumulators(series);
    }
  }
  return out;
}

function summarizeScalarAccumulators(
  series: readonly ScalarSeriesAccumulator[],
): ScalarSeriesSummary {
  const values = series.flatMap((entry) => entry.values).sort((a, b) => a - b);
  let first = 0;
  let last = 0;
  let delta = 0;
  let sampleCount = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const entry of series) {
    const firstValue = entry.first ?? 0;
    first += firstValue;
    last += entry.last;
    delta += entry.last - firstValue;
    sampleCount += entry.count;
    min = Math.min(min, entry.min);
    max = Math.max(max, entry.max);
  }
  return {
    kind: "scalar",
    series: series.length,
    samples: sampleCount,
    first,
    last,
    delta,
    min: Number.isFinite(min) ? min : 0,
    p50: percentile(values, 0.5),
    p99: percentile(values, 0.99),
    max: Number.isFinite(max) ? max : 0,
  };
}

function summarizeHistogramAccumulators(
  series: readonly HistogramSeriesAccumulator[],
): HistogramSummary {
  const bucketsByLe = new Map<number, number>();
  let sampleCount = 0;
  for (const entry of series) {
    sampleCount += entry.samples;
    for (const [bucket, value] of entry.buckets.entries()) {
      bucketsByLe.set(bucket, (bucketsByLe.get(bucket) ?? 0) + value);
    }
  }
  const buckets = Array.from(bucketsByLe.entries()).sort((a, b) => a[0] - b[0]);
  const finiteBuckets = buckets.filter(([bucket]) => Number.isFinite(bucket));
  const count = buckets.find(([bucket]) => bucket === Number.POSITIVE_INFINITY)?.[1] ??
    finiteBuckets[finiteBuckets.length - 1]?.[1] ??
    0;
  return {
    kind: "histogram",
    series: series.length,
    samples: sampleCount,
    count,
    p50: histogramQuantile(buckets, 0.5),
    p99: histogramQuantile(buckets, 0.99),
    max_bucket: finiteBuckets[finiteBuckets.length - 1]?.[0] ?? 0,
  };
}

function summarizeBySurface(
  samples: readonly ScrapedPrometheusSample[],
): Readonly<Record<string, Record<string, MetricSummary>>> {
  const scalarSeries = new Map<string, ScrapedPrometheusSample[]>();
  const histogramBuckets = new Map<string, ScrapedPrometheusSample[]>();

  for (const sample of samples) {
    if (sample.name.endsWith("_bucket") && sample.labels["le"] !== undefined) {
      const family = sample.name.slice(0, -"_bucket".length);
      const key = metricKey(sample.surface, family, labelsKey(withoutLabel(sample.labels, "le")));
      histogramBuckets.set(key, [...(histogramBuckets.get(key) ?? []), sample]);
      continue;
    }

    const key = metricKey(sample.surface, sample.name, labelsKey(sample.labels));
    scalarSeries.set(key, [...(scalarSeries.get(key) ?? []), sample]);
  }

  const groupedScalars = new Map<string, Map<string, Map<string, ScrapedPrometheusSample[]>>>();
  for (const [key, seriesSamples] of scalarSeries.entries()) {
    const parsed = parseMetricKey(key);
    const byMetric = groupedScalars.get(parsed.surface) ?? new Map();
    groupedScalars.set(parsed.surface, byMetric);
    const bySeries = byMetric.get(parsed.metric) ?? new Map();
    byMetric.set(parsed.metric, bySeries);
    bySeries.set(parsed.labelKey, seriesSamples);
  }

  const groupedHistograms = new Map<string, Map<string, Map<string, ScrapedPrometheusSample[]>>>();
  for (const [key, bucketSamples] of histogramBuckets.entries()) {
    const parsed = parseMetricKey(key);
    const byMetric = groupedHistograms.get(parsed.surface) ?? new Map();
    groupedHistograms.set(parsed.surface, byMetric);
    const bySeries = byMetric.get(parsed.metric) ?? new Map();
    byMetric.set(parsed.metric, bySeries);
    bySeries.set(parsed.labelKey, bucketSamples);
  }

  const out: Record<string, Record<string, MetricSummary>> = {};
  for (const [surface, byMetric] of groupedScalars.entries()) {
    const surfaceOut = out[surface] ?? {};
    out[surface] = surfaceOut;
    for (const [metric, bySeries] of byMetric.entries()) {
      surfaceOut[metric] = summarizeScalar(bySeries);
    }
  }
  for (const [surface, byMetric] of groupedHistograms.entries()) {
    const surfaceOut = out[surface] ?? {};
    out[surface] = surfaceOut;
    for (const [metric, bySeries] of byMetric.entries()) {
      surfaceOut[metric] = summarizeHistogram(bySeries);
    }
  }
  return out;
}

function summarizeScalar(
  bySeries: ReadonlyMap<string, readonly ScrapedPrometheusSample[]>,
): ScalarSeriesSummary {
  const values = Array.from(bySeries.values()).flatMap((series) =>
    series.map((sample) => sample.value),
  );
  const sorted = values.sort((a, b) => a - b);
  let first = 0;
  let last = 0;
  let delta = 0;
  for (const series of bySeries.values()) {
    const ordered = [...series].sort((a, b) => a.sampledAtMs - b.sampledAtMs);
    const firstValue = ordered[0]?.value ?? 0;
    const lastValue = ordered[ordered.length - 1]?.value ?? 0;
    first += firstValue;
    last += lastValue;
    delta += lastValue - firstValue;
  }
  return {
    kind: "scalar",
    series: bySeries.size,
    samples: sorted.length,
    first,
    last,
    delta,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function summarizeHistogram(
  bySeries: ReadonlyMap<string, readonly ScrapedPrometheusSample[]>,
): HistogramSummary {
  const latestBuckets = new Map<number, number>();
  let sampleCount = 0;
  for (const series of bySeries.values()) {
    const latestByBucket = new Map<number, ScrapedPrometheusSample>();
    for (const sample of series) {
      const bucket = parseLe(sample.labels["le"]);
      if (bucket === undefined) continue;
      sampleCount += 1;
      const current = latestByBucket.get(bucket);
      if (!current || sample.sampledAtMs >= current.sampledAtMs) {
        latestByBucket.set(bucket, sample);
      }
    }
    for (const [bucket, sample] of latestByBucket.entries()) {
      latestBuckets.set(bucket, (latestBuckets.get(bucket) ?? 0) + sample.value);
    }
  }
  const buckets = Array.from(latestBuckets.entries()).sort((a, b) => a[0] - b[0]);
  const finiteBuckets = buckets.filter(([bucket]) => Number.isFinite(bucket));
  const count = buckets.find(([bucket]) => bucket === Number.POSITIVE_INFINITY)?.[1] ??
    finiteBuckets[finiteBuckets.length - 1]?.[1] ??
    0;
  return {
    kind: "histogram",
    series: bySeries.size,
    samples: sampleCount,
    count,
    p50: histogramQuantile(buckets, 0.5),
    p99: histogramQuantile(buckets, 0.99),
    max_bucket: finiteBuckets[finiteBuckets.length - 1]?.[0] ?? 0,
  };
}

function rankMetricCandidates(
  perSurface: Readonly<Record<string, Record<string, MetricSummary>>>,
): readonly AttributionCandidate[] {
  const candidates: Array<AttributionCandidate & { readonly score: number }> = [];
  for (const [surface, byMetric] of Object.entries(perSurface)) {
    for (const [metric, summary] of Object.entries(byMetric)) {
      const candidate = candidateForMetric(surface, metric, summary);
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((candidate, index) => ({
      subsystem: candidate.subsystem,
      metric: candidate.metric,
      rank: index + 1,
      p99_ms: candidate.p99_ms,
      note: candidate.note,
    }));
}

function candidateForMetric(
  surface: string,
  metric: string,
  summary: MetricSummary,
): (AttributionCandidate & { readonly score: number }) | undefined {
  if (summary.kind === "histogram") {
    const p99Ms = metricValueToMs(metric, summary.p99);
    const thresholdMs = metric.includes("event_loop_lag") ? 50 : 250;
    const score = p99Ms === undefined ? summary.p99 : p99Ms / thresholdMs;
    return {
      subsystem: `${surface}.${metric}`,
      metric,
      rank: 0,
      p99_ms: p99Ms,
      note: `histogram count=${summary.count} p99=${round(summary.p99)} maxBucket=${round(summary.max_bucket)}`,
      score,
    };
  }

  if (isErrorOrRejectionMetric(metric) && summary.delta > 0) {
    return {
      subsystem: `${surface}.${metric}`,
      metric,
      rank: 0,
      note: `counter delta=${round(summary.delta)} last=${round(summary.last)}`,
      score: 10_000 + summary.delta,
    };
  }

  if (metric.includes("budget") && metric.includes("ratio")) {
    return {
      subsystem: `${surface}.${metric}`,
      metric,
      rank: 0,
      note: `budget ratio p99=${round(summary.p99)} max=${round(summary.max)}`,
      score: summary.p99 / 0.9,
    };
  }

  const p99Ms = metricValueToMs(metric, summary.p99);
  if (p99Ms !== undefined) {
    const thresholdMs = metric.includes("lag") ? 50 : 250;
    return {
      subsystem: `${surface}.${metric}`,
      metric,
      rank: 0,
      p99_ms: p99Ms,
      note: `samples=${summary.samples} delta=${round(summary.delta)} max=${round(summary.max)}`,
      score: p99Ms / thresholdMs,
    };
  }

  if (metric.includes("active_games") || metric.includes("active_sessions")) {
    return {
      subsystem: `${surface}.${metric}`,
      metric,
      rank: 0,
      note: `last=${round(summary.last)} max=${round(summary.max)}`,
      score: Math.max(summary.last, summary.max) / 100,
    };
  }

  return undefined;
}

function metricAttributionSentence(
  sampleCount: number,
  errorCount: number,
  candidates: readonly AttributionCandidate[],
): string {
  if (sampleCount === 0) {
    return errorCount > 0
      ? `No live Prometheus metric samples were collected; ${errorCount} scrape errors were recorded.`
      : "No live Prometheus metric samples were collected.";
  }
  const top = candidates[0];
  if (!top) {
    return `This rung exhibited no attributed Prometheus cliff across ${sampleCount} live samples.`;
  }
  const p99 = top.p99_ms === undefined ? "" : ` p99=${round(top.p99_ms)}ms`;
  return `Top live metric candidate is ${top.subsystem} (${top.metric};${p99} ${top.note ?? ""}).`;
}

function isErrorOrRejectionMetric(metric: string): boolean {
  return (
    metric.includes("error") ||
    metric.includes("rejected") ||
    metric.includes("rejections") ||
    metric.includes("exceeded")
  );
}

function metricValueToMs(metric: string, value: number): number | undefined {
  if (metric.endsWith("_ms") || metric.includes("_duration_ms")) return value;
  if (metric.endsWith("_seconds") || metric.includes("_duration_seconds")) {
    return value * 1_000;
  }
  return undefined;
}

function histogramQuantile(buckets: readonly (readonly [number, number])[], q: number): number {
  if (buckets.length === 0) return 0;
  const total = buckets.find(([bucket]) => bucket === Number.POSITIVE_INFINITY)?.[1] ??
    buckets[buckets.length - 1]?.[1] ??
    0;
  if (total <= 0) return 0;
  const wanted = total * q;
  let previousFinite = 0;
  for (const [bucket, cumulative] of buckets) {
    if (cumulative >= wanted) {
      return Number.isFinite(bucket) ? bucket : previousFinite;
    }
    if (Number.isFinite(bucket)) previousFinite = bucket;
  }
  return previousFinite;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[index] ?? 0;
}

function parsePrometheusLabels(raw: string): Readonly<Record<string, string>> {
  if (raw.length === 0) return {};
  const labels: Record<string, string> = {};
  for (const pair of splitLabelPairs(raw)) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator).trim();
    const rawValue = pair.slice(separator + 1).trim();
    if (!rawValue.startsWith('"') || !rawValue.endsWith('"')) continue;
    labels[name] = unescapePrometheusLabel(rawValue.slice(1, -1));
  }
  return labels;
}

function splitLabelPairs(raw: string): readonly string[] {
  const pairs: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaping = false;
  for (const char of raw) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaping = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === "," && !inQuotes) {
      pairs.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length > 0) pairs.push(current);
  return pairs;
}

function unescapePrometheusLabel(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function parseLe(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value === "+Inf" || value === "Inf") return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function labelsKey(labels: Readonly<Record<string, string>>): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function withoutLabel(
  labels: Readonly<Record<string, string>>,
  excluded: string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(labels).filter(([key]) => key !== excluded));
}

function metricKey(surface: string, metric: string, labelKey: string): string {
  return `${surface}\n${metric}\n${labelKey}`;
}

function parseMetricKey(key: string): {
  readonly surface: string;
  readonly metric: string;
  readonly labelKey: string;
} {
  const [surface, metric, labelKey] = key.split("\n");
  if (!surface || !metric) throw new Error(`invalid metric key ${key}`);
  return { surface, metric, labelKey: labelKey ?? "" };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
