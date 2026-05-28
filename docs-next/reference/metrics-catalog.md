# Metrics catalog

> Layer: **Reference catalog**

Every substrate Prometheus metric: name, type, unit, allowed labels,
buckets, owning surface. A CI metric-linter checks every metric
call-site against this catalog; new metrics require a catalog entry in
the same PR.

## Naming conventions

| Prefix | Owner |
|---|---|
| `pax_router_*` | Placement router |
| `pax_parent_*` | Parent actor |
| `pax_gateway_*` | API gateway |
| `pax_control_*` | Control plane |
| `pax_urlsvc_<kind>_*` | Reference URL services (one per kind) |
| `pax_driver_*` | Scenario-runner driver |
| `pax_creator_*` | Bundle-emitted (via `c.metrics.*`) |
| `rivet_*` | Vendored Rivet engine (untouched) |

Other prefixes are not allowed.

## Bucket standards

| Bucket set | Range | Use |
|---|---|---|
| `BUCKETS_SECONDS_FINE` | `0.0001 … 50` | sub-second to multi-second; default for handler/IPC durations |
| `BUCKETS_SECONDS_COARSE` | `0.001 … 500` | network calls, large transfers |
| `BUCKETS_BYTES_PAYLOAD` | `16 … 16M` | payload size distributions |
| `BUCKETS_BUDGET_RATIO` | `0 … 1` step `0.05` | budget consumption ratios |

## Label cardinality firewall

**Allowed Prometheus label values** (bounded):

- `shard_id` (≤ 10 in v1)
- `runner_name`, `pool_name`, `namespace_id` (handful)
- `kind` (registered API kinds; operator-controlled)
- `bundle_compat_tag` (low-cardinality by vercel-backend convention)
- `runtime_contract` (single integer)
- `game_id_bucket` = `hash(game_id) mod 256`
- `session_count_bucket` = exponential bucket (`1`, `10`, `100`, `1k`)
- `handler` ∈ enumerated set
- `mode` ∈ `{live, replay}`
- `result` ∈ enumerated error class set
- `direction` ∈ `{inbound, outbound}`
- `budget` ∈ the 8 compute budgets

**Forbidden as Prometheus labels** (unbounded):

- raw `game_id`, `session_id`, `player_id`, `actor_id`, `trace_id`,
  `request_id`, `bundle_name`, `database_id`

Unbounded IDs go on OTel span attributes (sampled), log lines, and
history events. Never on metric labels.

## Placement router (`pax_router_*`)

| Metric | Type | Unit | Labels | Buckets |
|---|---|---|---|---|
| `pax_router_placement_actor_create_ms` | histogram | seconds | `shard_id` | FINE |
| `pax_router_placement_decision_lock_wait_ms` | histogram | seconds | — | FINE |
| `pax_router_placement_decision_lock_hold_ms` | histogram | seconds | — | FINE |
| `pax_router_placement_decision_lock_contention_total` | counter | — | — | — |
| `pax_router_placement_capacity_row_staleness_ms` | histogram | seconds | `shard_id` | FINE |
| `pax_router_recent_wake_total` | counter | — | `shard_id` | — |
| `pax_router_recent_wake_distinct_games_gauge` | gauge | games | `shard_id` | — |
| `pax_router_runtime_contract_gate_rejections_total` | counter | — | `runtime_contract`, `supported_min`, `supported_max` | — |
| `pax_router_jwt_sign_duration_ms` | histogram | seconds | — | FINE |
| `pax_router_jwt_errors_total` | counter | — | `reason` | — |
| `pax_router_placement_duration_ms` | histogram | seconds | `result` | FINE |

## Parent actor (`pax_parent_*`)

| Metric | Type | Unit | Labels | Buckets |
|---|---|---|---|---|
| `pax_parent_frame_age_seconds` | histogram | seconds | `game_id_bucket`, `session_count_bucket` | FINE |
| `pax_parent_ipc_age_seconds` | histogram | seconds | `direction` | FINE |
| `pax_parent_broadcast_call_duration_seconds` | histogram | seconds | — | FINE |
| `pax_parent_broadcast_total_duration_seconds` | histogram | seconds | — | FINE |
| `pax_parent_broadcast_payload_bytes` | histogram | bytes | — | BYTES |
| `pax_parent_handler_duration_seconds` | histogram | seconds | `handler`, `result` | FINE |
| `pax_parent_event_loop_lag_seconds` | histogram | seconds | — | FINE |
| `pax_parent_compute_budget_consumed_ratio` | histogram | ratio | `budget` | RATIO |
| `pax_parent_compute_budget_warnings_total` | counter | — | `budget` | — |
| `pax_parent_child_pending_commands` | gauge | — | — | — |
| `pax_parent_child_lifecycle_total` | counter | — | `reason`, `kind` | — |
| `pax_parent_api_invoke_duration_seconds` | histogram | seconds | `kind`, `mode`, `result` | FINE |
| `pax_parent_engine_pressure_age_seconds` | histogram | seconds | — | FINE |
| `pax_parent_engine_tick_epoch_lag` | gauge | ticks | — | — |
| `pax_parent_state_flush_duration_seconds` | histogram | seconds | `result` | FINE |
| `pax_parent_state_flush_pending_writes` | gauge | — | — | — |
| `pax_parent_blob_op_duration_seconds` | histogram | seconds | `op`, `result` | FINE |
| `pax_parent_bundle_fetch_duration_seconds` | histogram | seconds | `cached` | COARSE |
| `pax_parent_bundle_cache_hit_total` | counter | — | — | — |

## API gateway (`pax_gateway_*`)

| Metric | Type | Unit | Labels | Buckets |
|---|---|---|---|---|
| `pax_gateway_invoke_duration_seconds` | histogram | seconds | `kind`, `mode`, `result` | COARSE |
| `pax_gateway_invoke_fingerprint_lookup_seconds` | histogram | seconds | `kind` | FINE |
| `pax_gateway_invoke_replay_coverage_gap_total` | counter | — | `kind` | — |
| `pax_gateway_url_service_http_duration_seconds` | histogram | seconds | `kind`, `status` | COARSE |
| `pax_gateway_envelope_bytes` | histogram | bytes | `kind`, `direction` | BYTES |
| `pax_gateway_api_rate_exceeded_total` | counter | — | `bundle_compat_tag` | — |
| `pax_gateway_kind_unknown_total` | counter | — | `kind` | — |

## Control plane (`pax_control_*`)

| Metric | Type | Unit | Labels | Buckets |
|---|---|---|---|---|
| `pax_control_admin_call_duration_seconds` | histogram | seconds | `endpoint`, `status` | COARSE |
| `pax_control_flip_gate_rejections_total` | counter | — | `reason` | — |
| `pax_control_bundle_upload_duration_seconds` | histogram | seconds | — | COARSE |
| `pax_control_bundle_storage_bytes` | gauge | bytes | — | — |
| `pax_control_host_event_total` | counter | — | `mode` (live/wakeOnDelivery) | — |
| `pax_control_host_event_delivery_total` | counter | — | `result` | — |
| `pax_control_history_query_duration_seconds` | histogram | seconds | `endpoint` | COARSE |
| `pax_control_shard_drain_duration_seconds` | histogram | seconds | — | COARSE |

## Reference URL services (`pax_urlsvc_<kind>_*`)

Each kind exposes:

| Metric | Type | Unit | Labels | Buckets |
|---|---|---|---|---|
| `pax_urlsvc_<kind>_invoke_duration_seconds` | histogram | seconds | `status` | COARSE |
| `pax_urlsvc_<kind>_invoke_errors_total` | counter | — | `error_class` | — |

E.g. `pax_urlsvc_echo_v1_invoke_duration_seconds`,
`pax_urlsvc_mock_ai_v1_invoke_duration_seconds`.

## Scenario-runner driver (`pax_driver_*`)

| Metric | Type | Unit | Labels |
|---|---|---|---|
| `pax_driver_workload_phase_duration_seconds` | histogram | seconds | `phase`, `result` |
| `pax_driver_oracle_check_duration_seconds` | histogram | seconds | `oracle`, `result` |
| `pax_driver_attribution_confidence_ratio` | gauge | ratio | `scenario` |

## Bundle-emitted (`pax_creator_*`)

Bundles emit metrics via `c.metrics.counter/gauge/histogram`. The
substrate validates the prefix and caps the per-game label combinations
at 16 distinct sets.

Bundle-defined names are not catalogued here — each bundle is responsible
for its own metrics documentation.

## Vendored Rivet (`rivet_*`)

Pass-through scrape from `:6430/metrics`. The substrate does not catalog
these — Rivet's own documentation is the source of truth. The Vector
sidecar cardinality-culls `actor_id_gen`, `database_id`, raw `game_id`
labels before remote-write.

## Adding a new metric

1. Pick the right prefix per the naming convention above.
2. Pick the smallest label set that answers the question; verify each
   label value is on the allowed list.
3. Pick the right bucket set if it's a histogram.
4. Add the entry to this catalog in the same PR as the metric
   call-site.
5. The metric-linter CI step fails the PR if the call-site doesn't
   match the catalog.

## Cross-references

- [`subsystems/observability.md`](../subsystems/observability.md) —
  the four-primitive contract
- [`event-schema.md`](event-schema.md) — sibling catalog for history events
- [`error-codes.md`](error-codes.md) — `result` and `error_class` enums
