# Phase 5 cost projection through 10k games

Date checked: 2026-05-28

This is infrastructure spend only. It does not add any gameplay accounting or
substrate-side payment concept.

## Evidence inputs

- `var/phase-5/fly-placement-proof-10-distribution.json`: 10 registered,
  healthy, wake-accepting shard rows and 256 placements distributed across all
  10 shards.
- `fly machines list` on 2026-05-28:
  - `pax-backend-shards`: 10 started `performance-4x`, 8GB machines in `iad`.
  - `pax-backend-control`: 2 started `shared-cpu-1x`, 1GB machines in `iad`.
  - `pax-backend-driver`: 1 started and 1 stopped `shared-cpu-1x`, 1GB machine.
- `fly volumes list -a pax-backend-shards`: 10 attached 20GB
  `pax_backend_rocks` volumes, one per shard.
- Local Task 4 artifacts: 116KB total for the placement smoke history and proof
  JSON. This is a placement-proof floor, not a full soak telemetry sample.

## Unit prices used

Provider prices were checked from public pages on 2026-05-28.

| Item | Price used | Source |
|---|---:|---|
| Fly `iad` `performance-4x`, 8GB | $0.1722/hour, $124.00/month | [Fly pricing](https://fly.io/docs/about/pricing/) |
| Fly `iad` `shared-cpu-1x`, 1GB | $0.0079/hour, $5.70/month | [Fly pricing](https://fly.io/docs/about/pricing/) |
| Fly `iad` `shared-cpu-4x`, 2GB | $0.0177/hour, $12.78/month | [Fly pricing](https://fly.io/docs/about/pricing/) |
| Fly Volumes | $0.15/GB-month provisioned | [Fly pricing](https://fly.io/docs/about/pricing/) |
| Fly volume snapshots | $0.08/GB-month stored, first 10GB free | [Fly pricing](https://fly.io/docs/about/pricing/) |
| Tigris Standard storage | $0.02/GB-month | [Tigris pricing](https://www.tigrisdata.com/pricing/) |
| Tigris Class A / Class B requests | $0.005 / 1k, $0.0005 / 1k | [Tigris pricing](https://www.tigrisdata.com/pricing/) |
| Better Stack telemetry bundles | 40GB $45/mo, 160GB $180/mo, 340GB $375/mo, 700GB $750/mo | [Better Stack pricing](https://betterstack.com/pricing) |

## Current v1-scale footprint

This is the current 1k-game target topology: 100 games per shard, 10 shard
machines. It intentionally uses the measured two-machine control app state.

| Component | Count | Unit | Monthly | 24h run |
|---|---:|---|---:|---:|
| Shards | 10 | `performance-4x`, 8GB | $1,240.00 | $41.33 |
| Shard volumes | 10 x 20GB | 200GB provisioned | $30.00 | $1.00 |
| Control/gateway/router | 2 | `shared-cpu-1x`, 1GB | $11.40 | $0.38 |
| Driver | 1 active | `shared-cpu-1x`, 1GB | $5.70 | $0.19 |
| Subtotal | | compute + provisioned volume | $1,287.10 | $42.90 |

The stopped driver standby still has rootfs cost; it is deliberately excluded
from this table because the current source of truth for stopped-machine rootfs
size is the Fly invoice/Cost Explorer, not `fly machines list`.

## 10k-game projection

The first-order projection keeps the proven density: 100 concurrent games per
shard machine. That means 100 shard machines for 10,000 games.

| Component | Count | Unit | Monthly | 24h run |
|---|---:|---|---:|---:|
| Shards | 100 | `performance-4x`, 8GB | $12,400.00 | $413.28 |
| Shard volumes | 100 x 20GB | 2,000GB provisioned | $300.00 | $10.00 |
| Control/gateway/router | 4 | `shared-cpu-4x`, 2GB | $51.12 | $1.70 |
| Drivers during tests | 4 | `shared-cpu-4x`, 2GB | $51.12 | $1.70 |
| Subtotal with drivers running | | compute + provisioned volume | $12,802.24 | $426.68 |
| Subtotal without drivers | | steady serving path | $12,751.12 | $424.98 |

Control and driver counts are intentionally conservative until the 1000-game
soak produces router/control CPU and request-latency attribution. The current
Task 4 proof did not show a control-plane capacity cliff; it only proved shard
registration and distribution after scaling.

## Storage assumptions

Fly volumes are the dominant durable local storage line because each shard has
an attached 20GB volume today. At 10k games, keeping that exact shape is 2TB of
provisioned Fly volume capacity, or $300/month.

Volume snapshots depend on changed blocks, not provisioned volume size. A
small-change assumption of 2GB changed per shard is about 200GB snapshot data
before the 10GB free allowance, or about $15.20/month. A worst-case full-volume
change assumption is about 2TB snapshot data, or about $159.20/month. The soak
should record actual snapshot growth before this graduates from projection.

Tigris is used for substrate object artifacts such as bundles, blobs, and
archived history. A working 10k-game budget is 100GB Standard storage plus 5M
Class A and 50M Class B requests per month:

| Tigris line | Assumption | Monthly |
|---|---:|---:|
| Standard storage | 100GB | $2.00 |
| Class A requests | 5,000,000 | $25.00 |
| Class B requests | 50,000,000 | $25.00 |
| Subtotal | | $52.00 |

The Task 6 soak must replace this request-count budget with measured Tigris
object counts and archive sizes. Storage itself is unlikely to dominate unless
history archival is accidentally chatty; request count is the likely watch item.

## Observability assumptions

The scenario-runner now aggregates scrape samples online, so local rung
artifacts do not grow with raw Prometheus sample volume. Provider-side logs,
metrics, and traces still need a hard budget:

| Scale | Better Stack cap | Monthly |
|---|---:|---:|
| 1k-game v1 soak | 160GB telemetry bundle | $180 |
| 10k-game projection | 700GB telemetry bundle | $750 |

The 10k number assumes production-facing Vector filters keep high-cardinality
labels bounded and that `cliff_hold` sampling is used only during tests. If a
full 10k soak exceeds 700GB/month equivalent telemetry, the next action is to
tighten sampling and metric-family allowlists, not to add any substrate
payment/accounting feature.

## Projection summary

| Scale | Infra subtotal | Storage extras | Observability cap | Working monthly projection |
|---|---:|---:|---:|---:|
| 1k games | $1,287.10 | $52 Tigris budget + $15.20 low-change snapshots | $180 | $1,534.30 |
| 10k games | $12,802.24 | $52 Tigris budget + $15.20 low-change snapshots | $750 | $13,619.44 |

The 10k figure is linear in shard count because the proven density is still
100 games per shard. Any improvement to games-per-shard has an immediate,
visible effect: every 10 additional games per shard at 10k scale removes about
9 shard machines, roughly $1,116/month of Fly compute plus $27/month of
provisioned volume.
