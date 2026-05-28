# Fly topology (v1)

The current v1 footprint inside Fly org **`pax-backend`**:

## Apps

| App | Role | Initial machine count |
|---|---|---|
| `pax-backend-shards` | Rivet shard image: parent actor + child runner + vendored Rivet. Each machine self-reports `runtimeContractsSupported` and `currentGameCount`. | 10 once the agent deploys real capacity; spin-up provisions 0 — apps are empty shells. |
| `pax-backend-control` | Placement router + control plane + API gateway + first-party reference URL services. All co-located on one machine in v1; split out as evidence demands. | 1 |
| `pax-backend-driver` | Scenario-runner driver machines. Spun up on demand for load runs and torn down after. | 0 idle |

## Storage

| Resource | Backing | Used for |
|---|---|---|
| Fly Volumes on `pax-backend-shards` | RocksDB per shard | `c.state` durability (shard-local) |
| Tigris bucket `pax-backend-blobs` | S3-compatible object storage | `c.blob` durability (cross-shard) + bundle blob storage |
| Upstash Redis `pax-backend-directory` | Managed Redis (via Fly) | active-game directory (shardId → games), capacity push from shards |
| **(no Postgres)** | n/a | The substrate has no ledger; URL services bring their own storage if they need any. |

## Secrets

Source of truth: Infisical project
`d4aa1707-46dc-4a66-8c13-0d5459f6757e`, env `dev`, path `/`. Synced to Fly by
[`scripts/bootstrap/spin-up.sh`](../../scripts/bootstrap/spin-up.sh) on every run; cross-app digest
drift is verified at the end of the run.

| Secret | Goes to apps |
|---|---|
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `BUCKET_NAME` | shards, control, driver |
| `REDIS_URL` | shards, control |
| `FLY_API_TOKEN` (org-scoped, 60-day expiry) | control, driver |
| `PAX_JWT_SECRET` (HS256, 64 bytes) | shards, control |

## Scale-up procedure

1. **Add shard machines:** `fly machine clone <existing> --app pax-backend-shards`
   with a new attached Volume per machine. The placement router learns about
   them through their first capacity push.
2. **Split co-located services off `pax-backend-control`:** create a new Fly
   app per service, deploy, point the relevant config at the new Flycast
   host. (The api-gateway URL registry needs no library change; only the
   `kindName → URL` mapping moves.)
3. **Burst driver capacity:** `fly machine run ... -a pax-backend-driver`
   with the scenario-runner image; tear down after the run.

Reference: this doc is updated as the topology evolves. The current set of
provisioned resources is whatever `scripts/spin-up.sh` would create on a
fresh run.
