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
CHUNK_BYTES="${PAX_FLY_PULL_CHUNK_BYTES:-4194304}"
REMOTE_ARCHIVE=""

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
  if [[ -n "$REMOTE_ARCHIVE" ]]; then
    quoted_remote_archive="$(quote_sh "$REMOTE_ARCHIVE")"
    fly machine exec "$MACHINE_ID" -a "$APP" --timeout "$EXEC_TIMEOUT" \
      "/bin/sh -lc $(quote_sh "rm -f $quoted_remote_archive")" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

quoted_remote_dir="$(quote_sh "$REMOTE_DIR")"
remote_cmd="set -eu; remote_dir=$quoted_remote_dir; test -d \"\$remote_dir\"; tmp=\$(mktemp /tmp/pax-soak-artifacts.XXXXXX.tar.gz); parent=\$(dirname \"\$remote_dir\"); base=\$(basename \"\$remote_dir\"); tar -C \"\$parent\" -czf \"\$tmp\" \"\$base\"; size=\$(wc -c < \"\$tmp\" | tr -d \" \"); printf \"%s %s\\n\" \"\$tmp\" \"\$size\""
remote_shell="/bin/sh -lc $(quote_sh "$remote_cmd")"

say "Pull remote soak artifacts"
archive_info="$(fly machine exec "$MACHINE_ID" -a "$APP" --timeout "$EXEC_TIMEOUT" "$remote_shell")"
REMOTE_ARCHIVE="$(awk '{print $1}' <<<"$archive_info")"
remote_size="$(awk '{print $2}' <<<"$archive_info")"
[[ -n "$REMOTE_ARCHIVE" && "$remote_size" =~ ^[0-9]+$ ]] \
  || err "remote archive setup failed: $archive_info"
[[ "$CHUNK_BYTES" =~ ^[0-9]+$ && "$CHUNK_BYTES" -gt 0 ]] \
  || err "PAX_FLY_PULL_CHUNK_BYTES must be a positive integer"

: > "$tmp_archive"
chunk_count=$(( (remote_size + CHUNK_BYTES - 1) / CHUNK_BYTES ))
quoted_remote_archive="$(quote_sh "$REMOTE_ARCHIVE")"
for ((chunk_index = 0; chunk_index < chunk_count; chunk_index += 1)); do
  chunk_cmd="set -eu; dd if=$quoted_remote_archive bs=$CHUNK_BYTES skip=$chunk_index count=1 2>/dev/null | base64"
  fly machine exec "$MACHINE_ID" -a "$APP" --timeout "$EXEC_TIMEOUT" \
    "/bin/sh -lc $(quote_sh "$chunk_cmd")" > "$tmp_encoded"
  base64 -d < "$tmp_encoded" >> "$tmp_archive"
done
if [[ ! -s "$tmp_archive" ]]; then
  err "downloaded archive is empty"
fi
ok "downloaded archive from $APP/$MACHINE_ID:$REMOTE_DIR ($remote_size bytes, $chunk_count chunks)"

mkdir -p "$LOCAL_DIR"
tar -xzf "$tmp_archive" -C "$tmp_extract"
if [[ ! -d "$tmp_extract/$remote_base" ]]; then
  err "archive did not contain expected directory $remote_base"
fi

tar -C "$tmp_extract/$remote_base" -cf - . | tar -C "$LOCAL_DIR" -xf -
ok "updated $LOCAL_DIR"
