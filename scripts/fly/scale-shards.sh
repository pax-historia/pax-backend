#!/usr/bin/env bash
set -euo pipefail

# Scale pax-backend-shards forward to the requested machine count.
#
# This script is intentionally scale-up-only. It never destroys machines,
# volumes, apps, buckets, or Redis instances; teardown remains hard-coded in
# scripts/bootstrap/tear-down.sh.
#
# Usage:
#   scripts/fly/scale-shards.sh 3
#   PAX_SHARD_MACHINE_TARGET=10 scripts/fly/scale-shards.sh

ORG="pax-backend"
APP="pax-backend-shards"
REGION="${PAX_SHARD_REGION:-iad}"
VOLUME_NAME="pax_backend_rocks"
DEFAULT_VOLUME_SIZE_GB=20
MAX_TARGET=10
TARGET="${1:-${PAX_SHARD_MACHINE_TARGET:-}}"

say()  { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
ok()   { printf "    \033[32m✓\033[0m %s\n" "$*"; }
skip() { printf "    \033[33m·\033[0m %s\n" "$*"; }
err()  { printf "    \033[31m✗\033[0m %s\n" "$*"; exit 1; }

command -v fly >/dev/null 2>&1 || err "fly CLI not installed"
command -v jq >/dev/null 2>&1 || err "jq not installed"
[[ -n "$TARGET" ]] || err "missing target count"
[[ "$TARGET" =~ ^[0-9]+$ ]] || err "target count must be an integer"
(( TARGET >= 1 && TARGET <= MAX_TARGET )) || err "target must be between 1 and $MAX_TARGET"

say "Org/app guard"
ORG_LIST_RAW="$(fly orgs list --json 2>/dev/null || true)"
echo "$ORG_LIST_RAW" | jq -e --arg org "$ORG" 'has($org)' >/dev/null \
  || err "Fly org '$ORG' not visible"
APPS_IN_ORG_RAW="$(fly apps list --org "$ORG" --json 2>/dev/null || echo '[]')"
echo "$APPS_IN_ORG_RAW" | jq -e --arg app "$APP" '
  [.[] | select(.Name == $app or .name == $app)] | length == 1
' >/dev/null || err "Fly app '$APP' not found in org '$ORG'"
ok "app '$APP' reachable in org '$ORG'"

machines_json() {
  fly machines list -a "$APP" --json
}

parse_volume_id() {
  jq -r 'if type == "array" then .[0].id else (.id // .ID) end'
}

machine_count() {
  jq 'length'
}

slot_shard_id() {
  printf "shard-fly-%s-%s" "$REGION" "$1"
}

machine_internal_host() {
  printf "%s.vm.%s.internal" "$1" "$APP"
}

normalize_machine_env() {
  local machine_id="$1"
  local slot="$2"
  local skip_start="${3:-no}"
  local shard_id internal_host internal_url valid_hosts
  shard_id="$(slot_shard_id "$slot")"
  internal_host="$(machine_internal_host "$machine_id")"
  internal_url="http://${internal_host}:6420"
  valid_hosts="${internal_host},${APP}.fly.dev,127.0.0.1,localhost"
  local args=(
    machine update "$machine_id"
    -a "$APP"
    --env "PAX_SHARD_SLOT=$slot"
    --env "PAX_SHARD_ID=$shard_id"
    --env "PAX_SHARD_PUBLIC_URL=$internal_url"
    --env "RIVET_PUBLIC_URL=$internal_url"
    --env "RIVET_VALID_HOSTS=$valid_hosts"
    --yes
    --skip-health-checks
  )
  if [[ "$skip_start" == "yes" ]]; then
    args+=(--skip-start)
  fi
  fly "${args[@]}" >/dev/null
  ok "$machine_id env -> $shard_id ($internal_url)"
}

create_machine_config() {
  local source_machine="$1"
  local volume_id="$2"
  local output_path="$3"
  jq --arg volume_id "$volume_id" --arg app "$APP" '
    .config
    | .mounts = [
        ((.mounts[0] // { "path": "/data", "name": "pax_backend_rocks" })
          | .volume = $volume_id
          | .path = "/data")
      ]
    | .env.PAX_SHARD_PUBLIC_URL = ("https://" + $app + ".fly.dev")
    | .env.RIVET_PUBLIC_URL = ("https://" + $app + ".fly.dev")
  ' <<<"$source_machine" > "$output_path"
}

say "Current shard machine inventory"
machines="$(machines_json)"
current_count="$(machine_count <<<"$machines")"
(( current_count > 0 )) || err "$APP has no source machine to clone from"
printf "%s\n" "$machines" | jq -r '.[] | [.id, .name, .state, (.config.env.PAX_SHARD_ID // "<unset>")] | @tsv'

if (( current_count > TARGET )); then
  err "refusing to downscale from $current_count to $TARGET; use Fly manually if you really intend to remove machines"
fi

say "Normalize existing machine identity"
mapfile -t existing_ids < <(printf "%s\n" "$machines" | jq -r 'sort_by(.created_at)[] | .id')
slot=1
for machine_id in "${existing_ids[@]}"; do
  normalize_machine_env "$machine_id" "$slot"
  slot=$((slot + 1))
done

if (( current_count == TARGET )); then
  skip "already at target count $TARGET"
else
  say "Create shard machines up to target $TARGET"
fi

while (( current_count < TARGET )); do
  machines="$(machines_json)"
  source_machine="$(printf "%s\n" "$machines" | jq 'sort_by(.created_at)[0]')"
  image_ref="$(jq -r '.config.image // .image_ref' <<<"$source_machine")"
  volume_size_gb="$(jq -r ".config.mounts[0].size_gb // $DEFAULT_VOLUME_SIZE_GB" <<<"$source_machine")"
  next_slot=$((current_count + 1))
  name="pax-shard-${REGION}-${next_slot}"

  say "Create volume for $name"
  volume_json="$(fly volumes create "$VOLUME_NAME" -a "$APP" -r "$REGION" -s "$volume_size_gb" --yes --json)"
  volume_id="$(parse_volume_id <<<"$volume_json")"
  [[ -n "$volume_id" && "$volume_id" != "null" ]] || err "could not parse created volume id"
  ok "created volume $volume_id (${volume_size_gb}GB)"

  tmp_config="$(mktemp)"
  create_machine_config "$source_machine" "$volume_id" "$tmp_config"
  say "Create stopped machine $name"
  fly machine create "$image_ref" -a "$APP" -r "$REGION" --name "$name" \
    --machine-config "$tmp_config" >/dev/null
  rm -f "$tmp_config"

  machines="$(machines_json)"
  machine_id="$(printf "%s\n" "$machines" | jq -r --arg name "$name" '
    [.[] | select(.name == $name)] | sort_by(.created_at) | last.id
  ')"
  [[ -n "$machine_id" && "$machine_id" != "null" ]] || err "could not find new machine $name"
  normalize_machine_env "$machine_id" "$next_slot" yes
  fly machine start "$machine_id" -a "$APP" >/dev/null
  fly machine wait "$machine_id" -a "$APP" --state started --wait-timeout 5m >/dev/null
  ok "started $machine_id as $(slot_shard_id "$next_slot")"
  current_count=$next_slot
done

say "Final shard machine inventory"
machines_json | jq -r 'sort_by(.created_at)[] | [
  .id,
  .name,
  .state,
  (.config.env.PAX_SHARD_SLOT // "<unset>"),
  (.config.env.PAX_SHARD_ID // "<unset>"),
  (.config.env.PAX_SHARD_PUBLIC_URL // "<unset>")
] | @tsv'

ok "target $TARGET reached for $APP"
