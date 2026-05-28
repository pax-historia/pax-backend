import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface CliOptions {
  readonly controlUrl: string;
  readonly historyPath?: string;
  readonly outputPath: string;
  readonly targetShards: number;
  readonly minPlacementShards?: number;
}

interface ShardRow {
  readonly shardId?: string;
  readonly status?: string;
  readonly healthy?: boolean;
  readonly acceptingWakes?: boolean;
  readonly activeGames?: number;
  readonly lastSeenAt?: number;
  readonly url?: string;
}

interface ShardsResponse {
  readonly shards?: readonly ShardRow[];
}

interface PlacementDistributionProof {
  readonly schema_version: 1;
  readonly kind: "placement-distribution-proof";
  readonly started_at: string;
  readonly control_url: string;
  readonly history_path?: string;
  readonly target_shards: number;
  readonly min_placement_shards: number;
  readonly shard_rows: readonly ShardRow[];
  readonly placement_distribution: Readonly<Record<string, number>>;
  readonly summary: {
    readonly registered_shards: number;
    readonly healthy_shards: number;
    readonly accepting_wake_shards: number;
    readonly placement_count: number;
    readonly observed_placement_shards: number;
    readonly capacity_rows_ok: boolean;
    readonly placement_distribution_ok: boolean;
  };
}

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const shards = await fetchJson<ShardsResponse>(`${trimSlash(options.controlUrl)}/admin/shards`);
const shardRows = (shards.shards ?? []).slice().sort((a, b) =>
  String(a.shardId ?? "").localeCompare(String(b.shardId ?? "")),
);
const distribution = options.historyPath
  ? await placementDistributionFromHistory(options.historyPath)
  : {};
const minPlacementShards =
  options.minPlacementShards ?? Math.min(options.targetShards, Object.values(distribution).reduce((sum, count) => sum + count, 0));
const summary = {
  registered_shards: shardRows.length,
  healthy_shards: shardRows.filter((row) => row.healthy !== false && row.status !== "unhealthy").length,
  accepting_wake_shards: shardRows.filter((row) => row.acceptingWakes !== false).length,
  placement_count: Object.values(distribution).reduce((sum, count) => sum + count, 0),
  observed_placement_shards: Object.keys(distribution).length,
  capacity_rows_ok:
    shardRows.length >= options.targetShards &&
    shardRows.filter((row) => row.healthy !== false && row.acceptingWakes !== false).length >=
      options.targetShards,
  placement_distribution_ok:
    !options.historyPath || Object.keys(distribution).length >= minPlacementShards,
};
const proof: PlacementDistributionProof = {
  schema_version: 1,
  kind: "placement-distribution-proof",
  started_at: startedAt,
  control_url: options.controlUrl,
  history_path: options.historyPath,
  target_shards: options.targetShards,
  min_placement_shards: minPlacementShards,
  shard_rows: shardRows,
  placement_distribution: distribution,
  summary,
};
await mkdir(dirname(resolve(options.outputPath)), { recursive: true });
await writeFile(options.outputPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);

if (!summary.capacity_rows_ok || !summary.placement_distribution_ok) {
  process.exitCode = 2;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) throw new Error(`unexpected positional argument: ${arg ?? ""}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
    values.set(arg.slice(2), value);
    i += 1;
  }
  return {
    controlUrl: values.get("control-url") ?? process.env["PAX_CONTROL_URL"] ?? "http://127.0.0.1:9070",
    historyPath: values.get("history"),
    outputPath: values.get("output") ?? "var/phase-5/placement-distribution-proof.json",
    targetShards: positiveInt(values.get("target-shards") ?? "1", "--target-shards"),
    minPlacementShards: values.has("min-placement-shards")
      ? positiveInt(values.get("min-placement-shards") ?? "", "--min-placement-shards")
      : undefined,
  };
}

async function placementDistributionFromHistory(
  path: string,
): Promise<Readonly<Record<string, number>>> {
  const raw = await readFile(path, "utf8");
  const counts = new Map<string, number>();
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`${path}:${index + 1} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (event["event"] !== "placement.accepted") continue;
    const shardId = stringValue(event["placedShardId"]) ?? stringValue(event["shardId"]);
    if (!shardId) continue;
    counts.set(shardId, (counts.get(shardId) ?? 0) + 1);
  }
  return Object.fromEntries(Array.from(counts.entries()).sort(([left], [right]) => left.localeCompare(right)));
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 500)}`);
  }
  return (text.trim().length === 0 ? {} : JSON.parse(text)) as T;
}

function positiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
