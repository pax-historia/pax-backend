# Redeploy runbook

> Stub. The three runbooks expand in step 11 of the plan's kickoff.

Three independently-deployable surfaces, three cadences. See [plan
README](../../README.md) §"Production redeploy strategy".

| Surface | Deploys to | Cadence | Player-visible effect |
|---|---|---|---|
| Orchestration (router / control plane / API gateway / reference URL services) | `pax-backend-control` | Multiple per day | Brief in-flight HTTP request drain on api.invoke; **WS connections are not affected** because the router is not in the WS path |
| Shard image (runtime + vendored Rivet) | `pax-backend-shards` | Daily – weekly | Per-shard drain; in-flight games run to natural sleep; blob is source of truth across the swap |
| Creator bundle | object storage + directory flip | Multiple per minute per creator | Existing games finish on old bundle unless creator force-restarts; new placements pick up new pointer |

To be filled in with player-visible-effect tables for each runbook (per the
plan's todo `expand-redeploy`).
