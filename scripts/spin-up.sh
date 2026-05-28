#!/usr/bin/env bash
# scripts/spin-up.sh
#
# Idempotent: creates whatever's missing, leaves whatever exists. Safe to
# re-run. Provisions the pax-backend infrastructure on Fly:
#
#   - Verifies Fly org `pax-backend` and the Infisical project (linked
#     via .infisical.json; created manually via the Infisical web UI)
#   - Fly app `pax-backend-shards`  (Rivet shard machines; agent deploys image)
#   - Fly app `pax-backend-control` (placement router + control plane +
#                                    api gateway + reference URL services)
#   - Fly app `pax-backend-driver`  (scenario-runner driver machines on demand)
#   - Fly Volume `pax_backend_rocks` (5 GB on shards, /data; starter — agent
#                                    grows to 10 volumes as it deploys shards)
#   - Tigris bucket `pax-backend-blobs` (AWS_* captured into Infisical on
#     first create, then synced to all three Fly apps)
#   - Upstash Redis `pax-backend-directory` (REDIS_URL captured into Infisical,
#     synced to shards + control)
#   - `PAX_JWT_SECRET` (HS256, 64 bytes) minted into Infisical, synced to
#     shards + control
#   - `FLY_API_TOKEN` minted org-scoped, 60-day expiry, captured into Infisical,
#     synced to control + driver
#
# Deliberately NOT provisioned: Postgres. The substrate has no ledger.
# Operator billing services bring their own storage if they need any.
#
# Infisical is the single source of truth for every secret value. Fly's
# digests are pre/post-compared on every sync so we can detect real changes.
# A final drift check verifies the apps hold identical digests for the
# shared secrets — caught silently-stale values in the prior spikes.
#
# Does NOT deploy any code. The agent is responsible for writing the
# Dockerfiles + fly.toml + source code, then running per-zone deploys.
#
# Hard guards:
#   - Refuses to run if the pax-backend Fly org isn't visible.
#   - Refuses to run if .infisical.json is missing (run `infisical init` first).
#   - Refuses to run if `infisical secrets --env dev` fails (run `infisical login`).

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
ORG="pax-backend"
REGION="iad"
SHARDS_APP="pax-backend-shards"
CONTROL_APP="pax-backend-control"
DRIVER_APP="pax-backend-driver"
ALL_APPS=("$SHARDS_APP" "$CONTROL_APP" "$DRIVER_APP")
# Fly volume names must be valid identifiers (underscore not dash).
VOLUME_NAME="pax_backend_rocks"
VOLUME_SIZE_GB=5
TIGRIS_BUCKET="pax-backend-blobs"
REDIS_NAME="pax-backend-directory"
FLY_TOKEN_EXPIRY_HOURS=1440  # 60 days
INFI_ENV="dev"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEND_MARKER="$REPO_ROOT/.pax-backend-spend-started"

# Shared-secret groups for drift verification. Each spec is "KEY:app1,app2,...".
SHARED_SECRETS=(
  "AWS_ACCESS_KEY_ID:$SHARDS_APP,$CONTROL_APP,$DRIVER_APP"
  "AWS_SECRET_ACCESS_KEY:$SHARDS_APP,$CONTROL_APP,$DRIVER_APP"
  "AWS_ENDPOINT_URL_S3:$SHARDS_APP,$CONTROL_APP,$DRIVER_APP"
  "AWS_REGION:$SHARDS_APP,$CONTROL_APP,$DRIVER_APP"
  "BUCKET_NAME:$SHARDS_APP,$CONTROL_APP,$DRIVER_APP"
  "REDIS_URL:$SHARDS_APP,$CONTROL_APP"
  "PAX_JWT_SECRET:$SHARDS_APP,$CONTROL_APP"
  "FLY_API_TOKEN:$CONTROL_APP,$DRIVER_APP"
)

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
say()  { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
ok()   { printf "    \033[32m✓\033[0m %s\n" "$*"; }
skip() { printf "    \033[33m·\033[0m %s\n" "$*"; }
warn() { printf "    \033[33m!\033[0m %s\n" "$*"; }
err()  { printf "    \033[31m✗\033[0m %s\n" "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Infisical helpers
# ---------------------------------------------------------------------------
# JSON, not dotenv. Structured format with unambiguous escaping; dotenv-in-shell
# has known footguns (the BSD sed `\?` no-op bug in the pax-spike-fly era
# corrupted every Fly secret once). python3 + json.loads handles every
# quoting / whitespace / multiline case.
INFI_JSON=""
infi_refresh() {
  INFI_JSON="$(infisical export --env "$INFI_ENV" --format=json 2>/dev/null || true)"
  if ! python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
assert isinstance(data, list), 'expected JSON array, got ' + type(data).__name__
" <<<"$INFI_JSON" 2>/dev/null; then
    err "infisical export returned non-JSON or unexpected shape. Run: infisical login"
  fi
}
infi_has() {
  KEY="$1" python3 -c "
import json, os, sys
key = os.environ['KEY']
data = json.loads(sys.stdin.read())
sys.exit(0 if any(s.get('key') == key for s in data) else 1)
" <<<"$INFI_JSON"
}
infi_get() {
  KEY="$1" python3 -c "
import json, os, sys
key = os.environ['KEY']
data = json.loads(sys.stdin.read())
for s in data:
    if s.get('key') == key:
        sys.stdout.write(s.get('value', ''))
        break
" <<<"$INFI_JSON"
}
infi_set() {
  local key="$1"
  local value="$2"
  infisical secrets set "${key}=${value}" --env "$INFI_ENV" >/dev/null 2>&1 \
    || err "infisical secrets set $key failed"
  infi_refresh
}

# ---------------------------------------------------------------------------
# Fly secret sync helpers
# ---------------------------------------------------------------------------
# Why always-sync, never skip-if-exists: a "skip if exists" guard makes
# Infisical not-the-source-of-truth — once a (possibly bad) value is on Fly,
# the script never refreshes it. Fly's API is server-side idempotent: setting
# a secret to its current value returns success and does NOT change the
# digest, so always-sync costs a few extra API calls per run. We use Fly's
# digest as the trust signal — pre/post comparison reveals real changes, and
# a final drift check verifies shared secrets agree across apps.
SYNC_CHANGED=0
SYNC_UNCHANGED=0
SYNC_FAILED=0
declare -a SYNC_CHANGES=()
declare -a SYNC_FAILURES=()

fly_digest() {
  local key="$1"
  local app="$2"
  fly secrets list -a "$app" 2>/dev/null | awk -F'│' -v key="$key" '
    {
      name = $1; gsub(/^[ \t*]+/, "", name); gsub(/[ \t]+$/, "", name)
      if (name == key) {
        d = $2; gsub(/[ \t]+/, "", d)
        print d; exit
      }
    }'
}

sync_one() {
  local key="$1"
  local app="$2"
  local value
  value="$(infi_get "$key")"
  if [[ -z "$value" ]]; then
    SYNC_FAILED=$((SYNC_FAILED+1))
    SYNC_FAILURES+=("$key on $app: missing in Infisical")
    warn "$app  X  $key (Infisical missing)"
    return 1
  fi
  local pre post
  pre="$(fly_digest "$key" "$app")"
  if ! fly secrets set "${key}=${value}" -a "$app" --stage >/dev/null 2>&1; then
    SYNC_FAILED=$((SYNC_FAILED+1))
    SYNC_FAILURES+=("$key on $app: fly secrets set failed")
    warn "$app  X  $key (fly set failed)"
    return 1
  fi
  post="$(fly_digest "$key" "$app")"
  if [[ "$pre" == "$post" ]]; then
    SYNC_UNCHANGED=$((SYNC_UNCHANGED+1))
    skip "$app  =  $key (digest ${post:-<empty>}, unchanged)"
  else
    SYNC_CHANGED=$((SYNC_CHANGED+1))
    SYNC_CHANGES+=("$key on $app: ${pre:-<missing>} -> $post")
    ok "$app  <-  $key (digest ${pre:-<missing>} -> $post)"
  fi
}

sync_from_infi() {
  local key="$1"; shift
  for app in "$@"; do
    sync_one "$key" "$app"
  done
}

verify_no_drift() {
  local rc=0
  for spec in "$@"; do
    local key="${spec%%:*}"
    local apps="${spec#*:}"
    local first_app="" first_digest="" mismatch=0
    IFS=',' read -ra APP_ARR <<<"$apps"
    for app in "${APP_ARR[@]}"; do
      local d
      d="$(fly_digest "$key" "$app")"
      if [[ -z "$first_app" ]]; then
        first_app="$app"; first_digest="$d"
      elif [[ "$d" != "$first_digest" ]]; then
        mismatch=1; rc=1
        warn "$key drift: $first_app=${first_digest:-<missing>}, $app=${d:-<missing>}"
      fi
    done
    if (( mismatch == 0 )); then
      ok "$key in sync across [${apps//,/, }] (digest=${first_digest:-<missing>})"
    fi
  done
  return $rc
}

# ---------------------------------------------------------------------------
# Prereqs
# ---------------------------------------------------------------------------
say "Prereq check"
command -v fly       >/dev/null 2>&1 || err "fly CLI not installed"
command -v infisical >/dev/null 2>&1 || err "infisical CLI not installed (brew install infisical/get-cli/infisical)"
command -v jq        >/dev/null 2>&1 || err "jq not installed (brew install jq)"
command -v python3   >/dev/null 2>&1 || err "python3 not installed"
command -v openssl   >/dev/null 2>&1 || err "openssl not installed"
WHOAMI="$(fly auth whoami 2>/dev/null || true)"
[[ -n "$WHOAMI" ]] || err "fly not authenticated — run 'fly auth login'"
ok "fly auth: $WHOAMI"

[[ -f "$REPO_ROOT/.infisical.json" ]] \
  || err ".infisical.json missing at repo root. Run: cd $REPO_ROOT && infisical init"
WORKSPACE_ID="$(python3 -c "import json; print(json.load(open('$REPO_ROOT/.infisical.json'))['workspaceId'])" 2>/dev/null || echo "")"
[[ -n "$WORKSPACE_ID" ]] || err ".infisical.json missing workspaceId"
if ! infisical secrets --env "$INFI_ENV" >/dev/null 2>&1; then
  err "infisical session expired or unauthorized. Run: infisical login"
fi
ok "infisical project: $WORKSPACE_ID (env=$INFI_ENV)"

# ---------------------------------------------------------------------------
# Org guard
# ---------------------------------------------------------------------------
say "Org guard: verifying '$ORG' org is reachable"
ORG_LIST_RAW="$(fly orgs list --json 2>/dev/null || true)"
echo "$ORG_LIST_RAW" | jq -e --arg org "$ORG" 'has($org)' >/dev/null 2>&1 \
  || err "Fly org '$ORG' not visible. Either create it ('fly orgs create $ORG') or fix your auth."
ok "org '$ORG' reachable"

infi_refresh

# ---------------------------------------------------------------------------
# Step 1/7: Apps
# ---------------------------------------------------------------------------
say "Step 1/7: Apps"
APPS_IN_ORG_RAW="$(fly apps list --org "$ORG" --json 2>/dev/null || echo '[]')"
ensure_app() {
  local app="$1"
  if echo "$APPS_IN_ORG_RAW" | jq -e --arg n "$app" '[.[] | select(.Name == $n)] | length > 0' >/dev/null 2>&1; then
    skip "$app exists"
    return 0
  fi
  local out
  if out="$(fly apps create "$app" --org "$ORG" 2>&1)"; then
    ok "created $app"
  else
    err "failed to create $app:
    $out
    Common causes:
      - 'We need your payment information' → add a card at https://fly.io/dashboard/$ORG/billing
      - 'Name has already been taken'      → $app is globally taken (Fly app names are global); pick a new slug"
  fi
}
for app in "${ALL_APPS[@]}"; do ensure_app "$app"; done

# ---------------------------------------------------------------------------
# Step 2/7: Starter Volume on shards app
# ---------------------------------------------------------------------------
say "Step 2/7: Starter Volume ($VOLUME_NAME, ${VOLUME_SIZE_GB}GB, $REGION) on $SHARDS_APP"
VOLUMES_RAW="$(fly volumes list --app "$SHARDS_APP" --json 2>/dev/null || echo '[]')"
EXISTING_VOL_COUNT="$(echo "$VOLUMES_RAW" | jq --arg n "$VOLUME_NAME" '[.[] | select(.name == $n and (.state // "created") != "destroyed")] | length')"
if [[ "$EXISTING_VOL_COUNT" -ge 1 ]]; then
  skip "volume $VOLUME_NAME already exists on $SHARDS_APP (count=$EXISTING_VOL_COUNT)"
else
  fly volumes create "$VOLUME_NAME" \
    --app "$SHARDS_APP" --region "$REGION" --size "$VOLUME_SIZE_GB" --yes \
    >/dev/null 2>&1 \
    && ok "created starter volume $VOLUME_NAME (${VOLUME_SIZE_GB}GB) in $REGION on $SHARDS_APP" \
    || err "failed to create volume $VOLUME_NAME on $SHARDS_APP"
fi

# ---------------------------------------------------------------------------
# Step 3/7: Tigris bucket + capture AWS_* into Infisical (first run only).
# `fly storage create --app X` provisions the bucket AND prints the AWS_*
# values on stdout. We capture stdout, parse the values, and stuff them into
# Infisical so subsequent syncs flow Infisical -> Fly (not Fly -> Infisical).
# Fly itself never exposes the secret values again after this point.
# ---------------------------------------------------------------------------
say "Step 3/7: Tigris bucket $TIGRIS_BUCKET"
STORAGE_LIST="$(fly storage list 2>/dev/null || true)"
if echo "$STORAGE_LIST" | grep -q "$TIGRIS_BUCKET"; then
  skip "bucket $TIGRIS_BUCKET already exists"
  if ! infi_has BUCKET_NAME; then
    warn "Bucket $TIGRIS_BUCKET exists but Infisical is missing AWS_* values."
    warn "Mint a fresh access key in the Tigris UI then store them in Infisical:"
    warn "  fly storage dashboard $TIGRIS_BUCKET  (Access Keys -> Create)"
    warn "  infisical secrets set AWS_ACCESS_KEY_ID=tid_...     --env $INFI_ENV"
    warn "  infisical secrets set AWS_SECRET_ACCESS_KEY=tsec_... --env $INFI_ENV"
    warn "  infisical secrets set AWS_ENDPOINT_URL_S3=https://fly.storage.tigris.dev --env $INFI_ENV"
    warn "  infisical secrets set AWS_REGION=auto                --env $INFI_ENV"
    warn "  infisical secrets set BUCKET_NAME=$TIGRIS_BUCKET     --env $INFI_ENV"
    warn "Then re-run this script."
  fi
else
  # `fly storage create` can print success then exit non-zero from an
  # interactive ToS prompt. Capture both stdout and stderr; re-check
  # afterwards via `fly storage list` to determine actual outcome.
  STORAGE_OUT="$(yes | fly storage create --org "$ORG" --name "$TIGRIS_BUCKET" --app "$SHARDS_APP" 2>&1 || true)"
  POST_LIST="$(fly storage list 2>/dev/null || true)"
  if echo "$POST_LIST" | grep -q "$TIGRIS_BUCKET"; then
    ok "created Tigris bucket $TIGRIS_BUCKET"
    captured=0
    while IFS= read -r line; do
      case "$line" in
        AWS_ACCESS_KEY_ID:*|AWS_SECRET_ACCESS_KEY:*|AWS_ENDPOINT_URL_S3:*|AWS_REGION:*|BUCKET_NAME:*)
          key="${line%%:*}"
          value="${line#*:}"
          value="${value#"${value%%[![:space:]]*}"}"
          value="${value%"${value##*[![:space:]]}"}"
          infi_set "$key" "$value"
          captured=$((captured+1))
          ;;
      esac
    done <<<"$STORAGE_OUT"
    ok "captured $captured AWS_* values into Infisical"
  else
    err "failed to create bucket $TIGRIS_BUCKET:
    $STORAGE_OUT
    Common causes:
      - Tigris reserves bucket names for ~24h after deletion; pick a different name or wait."
  fi
fi

# ---------------------------------------------------------------------------
# Step 4/7: Upstash Redis for the active-game directory.
# ---------------------------------------------------------------------------
say "Step 4/7: Upstash Redis '$REDIS_NAME'"
REDIS_LIST="$(fly redis list --org "$ORG" 2>/dev/null || true)"
if echo "$REDIS_LIST" | grep -q "$REDIS_NAME"; then
  skip "Redis $REDIS_NAME exists"
else
  # --enable-prodpack=false explicitly opts out of the $200/mo add-on prompt
  # (flyctl asks interactively otherwise even when all other prompts answered).
  fly redis create \
    --org "$ORG" \
    --region "$REGION" \
    --no-replicas \
    --name "$REDIS_NAME" \
    --disable-eviction \
    --enable-prodpack=false >/dev/null 2>&1 \
    && ok "created Upstash Redis $REDIS_NAME (no replicas, eviction disabled)" \
    || err "failed to create Redis $REDIS_NAME"
fi

# Capture REDIS_URL into Infisical.
# `fly redis status` formats as: ` Private URL    │ redis://default:pw@host:port`.
# Split on the box-drawing │ (not on `:`, which appears inside the URL itself).
if ! infi_has REDIS_URL; then
  REDIS_URL_VAL="$(fly redis status "$REDIS_NAME" 2>/dev/null | awk -F'│' '/Private URL/ {print $2}' | tr -d ' \r')"
  if [[ -n "$REDIS_URL_VAL" ]]; then
    infi_set REDIS_URL "$REDIS_URL_VAL"
    ok "captured REDIS_URL -> Infisical"
  else
    err "Could not extract Private URL from fly redis status"
  fi
else
  skip "REDIS_URL already in Infisical"
fi

# ---------------------------------------------------------------------------
# Step 5/7: PAX_JWT_SECRET (HS256, 64 bytes).
# Placement router signs short-lived JWTs to clients; shards verify on WS open.
# ---------------------------------------------------------------------------
say "Step 5/7: PAX_JWT_SECRET (HS256, 64 bytes)"
if ! infi_has PAX_JWT_SECRET; then
  infi_set PAX_JWT_SECRET "$(openssl rand -hex 64)"
  ok "generated PAX_JWT_SECRET -> Infisical"
else
  skip "PAX_JWT_SECRET already in Infisical"
fi

# ---------------------------------------------------------------------------
# Step 6/7: FLY_API_TOKEN — mint into Infisical on first run.
# ---------------------------------------------------------------------------
say "Step 6/7: FLY_API_TOKEN (org-scoped, ${FLY_TOKEN_EXPIRY_HOURS}h expiry)"
if ! infi_has FLY_API_TOKEN; then
  FLY_TOKEN="$(fly tokens create org "$ORG" --name "pax-backend $(date +%Y%m%d)" --expiry "${FLY_TOKEN_EXPIRY_HOURS}h" 2>/dev/null | grep '^FlyV1' | head -1)"
  if [[ -n "$FLY_TOKEN" ]]; then
    infi_set FLY_API_TOKEN "$FLY_TOKEN"
    ok "minted FLY_API_TOKEN -> Infisical"
    unset FLY_TOKEN
  else
    err "fly tokens create failed; provision manually:
    fly tokens create org $ORG --name 'pax-backend' --expiry ${FLY_TOKEN_EXPIRY_HOURS}h
    infisical secrets set FLY_API_TOKEN='FlyV1 ...' --env $INFI_ENV"
  fi
else
  skip "FLY_API_TOKEN already in Infisical"
fi

# ---------------------------------------------------------------------------
# Step 7/7: Sync all Infisical secrets to Fly apps. Always-sync (no skip-if-exists).
# Then verify cross-app digest equality for shared secrets.
# ---------------------------------------------------------------------------
say "Step 7/7: Sync secrets Infisical -> Fly (always-sync; idempotent at API level)"
if infi_has BUCKET_NAME; then
  for key in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_ENDPOINT_URL_S3 AWS_REGION BUCKET_NAME; do
    sync_from_infi "$key" "$SHARDS_APP" "$CONTROL_APP" "$DRIVER_APP"
  done
fi
if infi_has REDIS_URL; then
  sync_from_infi REDIS_URL "$SHARDS_APP" "$CONTROL_APP"
fi
if infi_has PAX_JWT_SECRET; then
  sync_from_infi PAX_JWT_SECRET "$SHARDS_APP" "$CONTROL_APP"
fi
if infi_has FLY_API_TOKEN; then
  sync_from_infi FLY_API_TOKEN "$CONTROL_APP" "$DRIVER_APP"
fi

say "Drift verification (cross-app digest equality)"
DRIFT_RC=0
verify_no_drift "${SHARED_SECRETS[@]}" || DRIFT_RC=$?

# ---------------------------------------------------------------------------
# Spend marker
# ---------------------------------------------------------------------------
if [[ -f "$SPEND_MARKER" ]]; then
  skip "spend marker exists ($(cat "$SPEND_MARKER")) — preserving"
else
  date -u +%s > "$SPEND_MARKER"
  ok "wrote spend marker: $SPEND_MARKER ($(cat "$SPEND_MARKER"))"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
say "spin-up complete"
printf "  Sync tally: %d changed, %d unchanged, %d failed\n" \
  "$SYNC_CHANGED" "$SYNC_UNCHANGED" "$SYNC_FAILED"
if (( SYNC_CHANGED > 0 )); then
  printf "\n  Changes this run:\n"
  for c in "${SYNC_CHANGES[@]}"; do printf "    - %s\n" "$c"; done
fi
if (( SYNC_FAILED > 0 )); then
  printf "\n  Failures this run:\n"
  for f in "${SYNC_FAILURES[@]}"; do printf "    - %s\n" "$f"; done
fi
if (( DRIFT_RC != 0 )); then
  warn "Drift detected above. Re-run this script to converge, or inspect the offending secret."
fi

cat <<EOF

  Fly org:        $ORG
  Shards app:     $SHARDS_APP     (Rivet shard image; agent deploys)
  Control app:    $CONTROL_APP    (placement router + control plane + api gateway + reference URL services)
  Driver app:     $DRIVER_APP     (scenario-runner driver machines, on demand)
  Starter volume: $VOLUME_NAME (${VOLUME_SIZE_GB}GB at /data on $SHARDS_APP; agent grows to 10)
  Tigris bucket:  $TIGRIS_BUCKET
  Redis:          $REDIS_NAME
  Infisical:      workspace=$WORKSPACE_ID env=$INFI_ENV

Local dev:
  infisical run --env $INFI_ENV -- <command>
  # or, if you need a file (gitignored):
  infisical export --env $INFI_ENV --format=dotenv > /tmp/pax-backend.env

Next:
  1. The agent owns deploys from here. See AGENTS.md.
  2. Pick a step from README.md §"Agent kickoff instructions" and land it.
  3. Tear down via PAX_BACKEND_TEARDOWN_CONFIRM=yes ./scripts/tear-down.sh

EOF

exit $DRIFT_RC
