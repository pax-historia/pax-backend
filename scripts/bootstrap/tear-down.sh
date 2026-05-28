#!/usr/bin/env bash
# scripts/tear-down.sh
#
# Permanently destroys the allowlisted pax-backend resources:
#
#   - Fly app: pax-backend-shards   (and its mounted volume pax_backend_rocks)
#   - Fly app: pax-backend-control
#   - Fly app: pax-backend-driver
#   - Tigris bucket: pax-backend-blobs
#   - Upstash Redis: pax-backend-directory
#
# Refuses to touch anything else. The Fly org itself is intentionally
# preserved (destroy via dashboard if you really want to). Infisical secret
# VALUES are intentionally preserved — that's the whole point of using
# Infisical as the source of truth: re-run spin-up.sh and secrets sync
# back to Fly without re-minting.
#
# This is the SINGLE MOST SAFETY-CRITICAL script in the seed. The allowlist
# is hard-coded; any attempt to extend it via flags is intentionally absent.
# If the agent finds itself needing to edit this allowlist, it must stop and
# report instead (see AGENTS.md).
#
# Usage:
#   PAX_BACKEND_TEARDOWN_CONFIRM=yes ./scripts/bootstrap/tear-down.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# HARD-CODED ALLOWLIST — do not generalize, do not parameterize.
# Any change here is a deliberate, reviewable diff.
# ---------------------------------------------------------------------------
ORG="pax-backend"
ALLOWED_APPS=("pax-backend-shards" "pax-backend-control" "pax-backend-driver")
ALLOWED_BUCKETS=("pax-backend-blobs")
ALLOWED_REDIS=("pax-backend-directory")
# destroyed implicitly when its app is destroyed; listed for clarity
ALLOWED_VOLUMES=("pax_backend_rocks")

SPEND_MARKER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.pax-backend-spend-started"

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
say()  { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
ok()   { printf "    \033[32m✓\033[0m %s\n" "$*"; }
skip() { printf "    \033[33m·\033[0m %s\n" "$*"; }
warn() { printf "    \033[33m!\033[0m %s\n" "$*"; }
err()  { printf "    \033[31m✗\033[0m %s\n" "$*"; }
die()  { printf "\033[31m==> %s\033[0m\n" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Confirmation gate.
# ---------------------------------------------------------------------------
if [[ "${PAX_BACKEND_TEARDOWN_CONFIRM:-no}" != "yes" ]]; then
  cat >&2 <<EOF

This script PERMANENTLY destroys:
  - Fly apps:       ${ALLOWED_APPS[*]}
  - Tigris buckets: ${ALLOWED_BUCKETS[*]}
  - Upstash Redis:  ${ALLOWED_REDIS[*]}
  - Volumes:        ${ALLOWED_VOLUMES[*]} (implicitly, when their app is destroyed)
  + removes the spend marker at: $SPEND_MARKER

  All data on the Volume, in Tigris, and in Redis is gone forever after this runs.

  Re-run with PAX_BACKEND_TEARDOWN_CONFIRM=yes to proceed.

EOF
  exit 1
fi

if [[ $# -ne 0 ]]; then
  die "tear-down.sh accepts no arguments. Refusing. (Got: $*)"
fi

# ---------------------------------------------------------------------------
# Prereqs
# ---------------------------------------------------------------------------
say "Prereq check"
command -v fly >/dev/null 2>&1 || die "fly CLI not installed"
command -v jq  >/dev/null 2>&1 || die "jq not installed"
WHOAMI="$(fly auth whoami 2>/dev/null || true)"
[[ -n "$WHOAMI" ]] || die "fly not authenticated"
ok "fly auth: $WHOAMI"

# ---------------------------------------------------------------------------
# Org guard: re-verify pax-backend is reachable. We do NOT enumerate apps
# in any other org. If fly's CLI default-context has drifted somewhere,
# this catches it before we destroy anything.
# ---------------------------------------------------------------------------
say "Org guard"
ORG_LIST_RAW="$(fly orgs list --json 2>/dev/null || true)"
echo "$ORG_LIST_RAW" | jq -e --arg org "$ORG" 'has($org)' >/dev/null 2>&1 \
  || die "Fly org '$ORG' not visible. Refusing to destroy anything."
ok "org '$ORG' reachable"

# ---------------------------------------------------------------------------
# Step 1/4: Destroy allowlisted apps.
# Each iteration verifies the app belongs to ORG before destroying.
# ---------------------------------------------------------------------------
say "Step 1/4: Destroy apps (allowlist: ${ALLOWED_APPS[*]})"
APPS_IN_ORG_RAW="$(fly apps list --org "$ORG" --json 2>/dev/null || echo '[]')"
for app in "${ALLOWED_APPS[@]}"; do
  if ! echo "$APPS_IN_ORG_RAW" | jq -e --arg n "$app" '[.[] | select(.Name == $n)] | length > 0' >/dev/null 2>&1; then
    skip "$app (not found in org '$ORG'; refusing to destroy)"
    continue
  fi
  fly apps destroy "$app" --yes >/dev/null 2>&1 && ok "destroyed $app" || err "failed to destroy $app"
done

# ---------------------------------------------------------------------------
# Step 2/4: Destroy allowlisted Tigris buckets.
# Bucket names are globally reserved for ~24h after deletion (Tigris cooldown).
# ---------------------------------------------------------------------------
say "Step 2/4: Destroy Tigris buckets (allowlist: ${ALLOWED_BUCKETS[*]})"
STORAGE_LIST="$(fly storage list 2>/dev/null || true)"
for bucket in "${ALLOWED_BUCKETS[@]}"; do
  if echo "$STORAGE_LIST" | grep -q "$bucket"; then
    fly storage destroy "$bucket" --yes >/dev/null 2>&1 && ok "destroyed bucket $bucket" || err "failed to destroy bucket $bucket"
  else
    skip "bucket $bucket (not present)"
  fi
done

# ---------------------------------------------------------------------------
# Step 3/4: Destroy allowlisted Upstash Redis instances.
# ---------------------------------------------------------------------------
say "Step 3/4: Destroy Upstash Redis (allowlist: ${ALLOWED_REDIS[*]})"
REDIS_LIST="$(fly redis list --org "$ORG" 2>/dev/null || true)"
for redis in "${ALLOWED_REDIS[@]}"; do
  if echo "$REDIS_LIST" | grep -q "$redis"; then
    fly redis destroy "$redis" --yes >/dev/null 2>&1 && ok "destroyed Redis $redis" || err "failed to destroy Redis $redis"
  else
    skip "Redis $redis (not present)"
  fi
done

# ---------------------------------------------------------------------------
# Step 4/4: Clear local spend marker.
# ---------------------------------------------------------------------------
say "Step 4/4: Clear local spend marker"
if [[ -f "$SPEND_MARKER" ]]; then
  rm -f "$SPEND_MARKER"
  ok "removed $SPEND_MARKER"
else
  skip "no spend marker to remove"
fi

# ---------------------------------------------------------------------------
say "tear-down complete"
cat <<EOF

  Destroyed apps:        ${ALLOWED_APPS[*]}
  Destroyed buckets:     ${ALLOWED_BUCKETS[*]}
  Destroyed Redis:       ${ALLOWED_REDIS[*]}
  (Volumes are destroyed implicitly when their app is destroyed.)

What's preserved:
  - Fly org '$ORG' (destroy via dashboard if you want it gone)
  - Infisical project + secret values (Infisical is the source of truth;
    that's the whole point of using it — on next spin-up.sh, secrets sync
    back to Fly without re-minting)
  - 60-day org-scoped FLY_API_TOKEN (it lives in Infisical now; the Fly
    token itself remains valid until expiry — revoke via
    'fly tokens revoke <id>' if you really want to invalidate it)
  - The git history in this repo (this script never touches it)

EOF
