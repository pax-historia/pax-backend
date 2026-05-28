#!/usr/bin/env bash
set -euo pipefail

# Safely copy a remote driver soak directory into local var/.
#
# Usage:
#   PAX_FLY_DRIVER_MACHINE_ID=1854539b257768 \
#     scripts/fly/pull-soak-artifacts.sh \
#       /data/phase-5/soak/ivm-20260528T222045Z \
#       var/phase-5/soak/ivm-20260528T222045Z

APP="${PAX_FLY_DRIVER_APP:-pax-backend-driver}"
MACHINE_ID="${PAX_FLY_DRIVER_MACHINE_ID:-}"
REMOTE_DIR="${1:-}"
LOCAL_DIR="${2:-}"
EXEC_TIMEOUT="${PAX_FLY_EXEC_TIMEOUT:-120}"

say() { printf "\n\033[1;34m==> %s\033[0m\n" "$*"; }
ok() { printf "    \033[32m✓\033[0m %s\n" "$*"; }
err() { printf "    \033[31m✗\033[0m %s\n" "$*"; exit 1; }

usage() {
  cat >&2 <<'USAGE'
Usage:
  PAX_FLY_DRIVER_MACHINE_ID=<machine-id> scripts/fly/pull-soak-artifacts.sh REMOTE_DIR [LOCAL_DIR]

Defaults:
  PAX_FLY_DRIVER_APP=pax-backend-driver
  LOCAL_DIR=var/phase-5/soak/<basename REMOTE_DIR>
USAGE
}

quote_sh() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

command -v fly >/dev/null 2>&1 || err "fly CLI not installed"
command -v tar >/dev/null 2>&1 || err "tar not installed"
command -v base64 >/dev/null 2>&1 || err "base64 not installed"

if [[ -z "$MACHINE_ID" || -z "$REMOTE_DIR" ]]; then
  usage
  exit 2
fi

remote_base="$(basename "$REMOTE_DIR")"
if [[ -z "$LOCAL_DIR" ]]; then
  LOCAL_DIR="var/phase-5/soak/$remote_base"
fi

tmp_encoded="$(mktemp -t pax-soak-artifacts.XXXXXX.b64)"
tmp_archive="$(mktemp -t pax-soak-artifacts.XXXXXX.tar.gz)"
tmp_extract="$(mktemp -d -t pax-soak-artifacts.XXXXXX)"
cleanup() {
  rm -f "$tmp_encoded"
  rm -f "$tmp_archive"
  rm -rf "$tmp_extract"
}
trap cleanup EXIT

quoted_remote_dir="$(quote_sh "$REMOTE_DIR")"
remote_cmd="set -eu; remote_dir=$quoted_remote_dir; test -d \"\$remote_dir\"; parent=\$(dirname \"\$remote_dir\"); base=\$(basename \"\$remote_dir\"); tar -C \"\$parent\" -czf - \"\$base\" | base64"
remote_shell="/bin/sh -lc $(quote_sh "$remote_cmd")"

say "Pull remote soak artifacts"
fly machine exec "$MACHINE_ID" -a "$APP" --timeout "$EXEC_TIMEOUT" "$remote_shell" > "$tmp_encoded"
base64 -d < "$tmp_encoded" > "$tmp_archive"
if [[ ! -s "$tmp_archive" ]]; then
  err "downloaded archive is empty"
fi
ok "downloaded archive from $APP/$MACHINE_ID:$REMOTE_DIR"

mkdir -p "$LOCAL_DIR"
tar -xzf "$tmp_archive" -C "$tmp_extract"
if [[ ! -d "$tmp_extract/$remote_base" ]]; then
  err "archive did not contain expected directory $remote_base"
fi

tar -C "$tmp_extract/$remote_base" -cf - . | tar -C "$LOCAL_DIR" -xf -
ok "updated $LOCAL_DIR"
