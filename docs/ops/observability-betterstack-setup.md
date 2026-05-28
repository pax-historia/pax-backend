# BetterStack provisioning runbook

> Companion to [`docs/ops/observability.md`](./observability.md). This doc
> covers only the one-time + ongoing setup of BetterStack resources; the
> *why* and the design are in the main observability doc.
> Last reviewed 2026-05-27.

BetterStack has no first-party CLI; the entire surface is a REST API
(`https://telemetry.betterstack.com/api/v1` and `/api/v2`, plus
`https://uptime.betterstack.com/api/v3` for heartbeats) with bearer-token
auth, plus an official Terraform provider we deliberately don't use
(sister-spike convention is no Terraform). Provisioning is therefore a small
idempotent script.

---

## 1. One-time manual seed (already done)

**Status: complete.** The team uses an existing **global** API token (not a
team-scoped Telemetry API token). The token is in the developer's possession;
first implementation step is to drop it into Infisical:

```bash
infisical secrets set BETTERSTACK_API_TOKEN=<existing-global-token> --env=dev
```

Two consequences of using a global token (verified against BetterStack's API
docs):

1. Every `POST /api/v1/sources` (and equivalent dashboard/heartbeat creates)
   **must include `team_name` in the body**. Per-team Telemetry tokens omit it.
   The provisioning script hardcodes `team_name: "Pax-Historia"` (the existing
   team's literal name in BetterStack).
2. Token rotation is a manual step in the web UI; the script logs the token's
   age on every run and warns if it's > 365 days.

If we ever need to mint a fresh global or Telemetry API token: BetterStack
web UI → `API tokens` → choose `Global API tokens` or
`Team-based tokens → Telemetry API tokens`.

---

## 2. Known starting state (inspected during planning, 2026-05-27)

Recorded so the provisioning script doesn't waste a run rediscovering it:

| Resource | Current value | Note for the script |
|---|---|---|
| Team name | `Pax-Historia` | Pass as `team_name` in every create body |
| Team ID | `527589` | Visible in BetterStack URLs; not used by the script |
| Existing sources (3) | `paxhistoria` (vercel_integration), `Preset Asset Processor (Modal)` (open_telemetry), `Game Screenshotting Service [VPS1]` (docker) | None collide with `pax-backend-*` prefix |
| Existing source groups (1) | `Vercel: Pax Historia` (id `24602347`) | Don't touch; create new `Pax Backend` source group |
| Existing dashboards (11) | All BetterStack stock templates (Tracing, OpenTelemetry collector, Alerts, Hosts, Services, Better Stack Collector, Host (Vector), Docker, Redis, etc.) | Don't touch; create new dashboards in a dedicated `Pax Backend` dashboard group |
| Existing dashboard groups | 0 | Free to create `Pax Backend` dashboard group cleanly |
| Heartbeat API host | `uptime.betterstack.com` (separate from `telemetry.betterstack.com`) | Script must hit two API hosts; auth header is the same global token |
| Data region for new sources | `us_east` (matches Fly `iad`) | Hardcoded in source manifest |

---

## 3. `scripts/observability/provision-betterstack.mjs` (planned)

A new ~150-line Node script (no new dependencies; `fetch` is built into Node
22). Modeled on the idempotency pattern of
[`scripts/bootstrap/spin-up.sh`](../../scripts/bootstrap/spin-up.sh).

### 3.1 Inputs (env)

- `BETTERSTACK_API_TOKEN` (from Infisical; abort with instructions if missing)
- `BETTERSTACK_TEAM_NAME` (default `"Pax-Historia"`; included in every create
  body because the token is global, not team-scoped)
- `PAX_ENV` ∈ {`prod`, `local-dev`}
- `PAX_DEV_HANDLE` (defaults to `$USER`; only used when `PAX_ENV=local-dev`)
- `PAX_DATA_REGION` (default `us_east`)

### 3.2 Behavior

1. List existing sources via `GET /api/v1/sources` (paginate). Build name →
   source-id map.
2. For each entry in the canonical source manifest (a const array inside the
   script):
   - If the source exists by name: `PATCH /api/v1/sources/:id` to reconcile
     `name`, `data_region`, `retention`, tags, ingest pause state.
   - If not: `POST /api/v1/sources` with `{name, platform, data_region,
     retention, tags: [service, env, zone, signal]}`. Body returns `id`,
     `token`, `ingesting_host`.
3. For each source's `token` and `ingesting_host`:
   - `PAX_ENV=prod` → `infisical secrets set BETTERSTACK_<SERVICE>_<SIGNAL>_TOKEN=<token>`
     and `..._INGESTING_HOST=<host>` under `--env=dev`.
   - `PAX_ENV=local-dev` → append to `./.env.local-dev` (gitignored), never to
     Infisical.
4. For each shard in the canonical shard list (read from Fly app
   `pax-backend-shards` machine inventory):
   `POST https://uptime.betterstack.com/api/v3/heartbeats` if missing; write
   the returned URL to Infisical as
   `BETTERSTACK_HEARTBEAT_URL_<MACHINE_ID>`. Heartbeats are prod-only.
5. (Optional, behind `--bootstrap-dashboards`) Load JSON dashboard files from
   `scripts/observability/betterstack-dashboards/*.json` and
   `POST /api/v2/dashboards` for any missing by name; `PUT` for existing.
6. Print a summary: sources created/updated, secrets written, heartbeats
   configured.

The script is **idempotent**: running it twice does nothing the second time
except print "no changes." It's run:

- On every `scripts/bootstrap/spin-up.sh` invocation (as a sub-step, after
  Infisical is verified and before Fly secret sync).
- On demand for any developer setting up local dev:
  `PAX_ENV=local-dev node scripts/observability/provision-betterstack.mjs`.
- As a CI check that the source manifest in code matches what's live in
  BetterStack (drift-detection mode: `--check` flag exits non-zero on drift
  instead of mutating).

### 3.3 Source manifest (canonical list)

The script's const array. Each entry produces two BetterStack Sources (one
logs, one OTLP/traces) so the signal-platform constraint is satisfied. For
`PAX_ENV=local-dev`, `-prod` is replaced by `-local-dev-<USER>`.

| Service group | Zone | Signals (one Source per signal) |
|---|---|---|
| `pax-backend-router` | orchestration | `vector` (logs + scraped metrics), `open_telemetry` (traces) |
| `pax-backend-parent` | runtime | same pair |
| `pax-backend-gateway` | orchestration | same pair |
| `pax-backend-control` | orchestration | same pair |
| `pax-backend-rivet-engine` | vendor | same pair |
| `pax-backend-urlsvc-echo` | orchestration | same pair |
| `pax-backend-urlsvc-delay` | orchestration | same pair |
| `pax-backend-urlsvc-http-fetch` | orchestration | same pair |
| `pax-backend-urlsvc-mock-ai-v1` | orchestration | same pair |
| `pax-backend-urlsvc-billing-mock-v1` | orchestration | same pair |

Add a row when a new service group is introduced; remove a row when a service
group is retired (and then run §6 prune separately).

### 3.4 Dashboard manifest

Three initial dashboards inside a `Pax Backend` dashboard group:

- `pax-backend / runtime` — parent / child / engine panels
- `pax-backend / orchestration` — router / control / gateway / URL-services
  panels
- `pax-backend / testing` — scenario-runner run-history view with attribution
  sentences pinned

JSON definitions live at `scripts/observability/betterstack-dashboards/`
(planned). Each dashboard's `source_eligibility_sql` filter scopes to
`service LIKE 'pax-backend-%'` so it never pulls data from other teams'
services.

---

## 4. `scripts/bootstrap/tear-down.sh` interaction

Following the existing repo convention
([AGENTS.md](../../AGENTS.md) §"Refusing to extend the teardown allowlist"),
the BetterStack teardown story is:

- **`scripts/bootstrap/tear-down.sh` does NOT delete BetterStack sources.**
  Same rationale as Tigris bucket survival: historical data has value, and
  re-creating sources later loses correlation. Sources are explicitly listed
  as "survives teardown by design" in the script's own header comment,
  matching today's Infisical-secrets behavior.
- A separate `scripts/observability/prune-betterstack.mjs --confirm=yes`
  exists for the rare case of wanting to delete sources (e.g. retiring a
  service group). It iterates the canonical manifest, deletes any source
  whose name matches the prefix, and warns on each delete with a 10-second
  countdown. Never called from `tear-down.sh`.

---

## 5. What's intentionally NOT in the provisioning script

- **Alerts** — first cut, alert rules live in the BetterStack web UI as a
  manual one-time setup, because they're tightly coupled to threshold values
  that come from live operating evidence (the `pax-spike-fly` lesson —
  thresholds are earned, not declared). When the alert set stabilizes, we
  move them to JSON files under `scripts/observability/betterstack-alerts/`
  and add a script step.
- **Team / user management** — out of scope. Members are managed in the
  BetterStack UI.
- **Per-source retention overrides** — defaults from team plan. Override
  case-by-case only if cost evidence demands.
- **Cross-team migration** — if we ever spin pax-backend out into its own
  team, that's a one-time manual export/import operation, not something the
  substrate provisions.

---

## 6. Quick reference: what to run, when

| Situation | Command |
|---|---|
| Brand-new dev machine | `infisical run --env=dev -- node scripts/observability/provision-betterstack.mjs` |
| First-time team-scoped token mint | Web UI (one-time), then store in Infisical |
| Adding a new service group | Edit §3.3 manifest in the script, re-run; idempotent reconciles |
| Local dev setup | `PAX_ENV=local-dev node scripts/observability/provision-betterstack.mjs` |
| Drift check in CI | `node scripts/observability/provision-betterstack.mjs --check` |
| Retire a source group (rare) | `node scripts/observability/prune-betterstack.mjs --confirm=yes` (manual only) |
