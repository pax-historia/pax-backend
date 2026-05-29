#!/usr/bin/env bash
set -euo pipefail

buffer_dir="${PAX_VECTOR_BUFFER_DIR:-/data/observability}"
max_bytes="${PAX_VECTOR_LOCAL_BUFFER_MAX_BYTES:-536870912}"

[[ "$max_bytes" =~ ^[0-9]+$ ]] || exit 0
(( max_bytes > 0 )) || exit 0
[[ -d "$buffer_dir" ]] || exit 0

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

find "$buffer_dir" -maxdepth 1 -type f \( -name '*.jsonl' -o -name '*.jsonl.gz' \) -print \
  | while IFS= read -r file; do
      size="$(stat -c '%s' "$file" 2>/dev/null || stat -f '%z' "$file" 2>/dev/null || echo 0)"
      mtime="$(stat -c '%Y' "$file" 2>/dev/null || stat -f '%m' "$file" 2>/dev/null || echo 0)"
      printf '%s %s %s\n' "$mtime" "$size" "$file"
    done \
  | sort -n > "$tmp"

total="$(awk '{ sum += $2 } END { print sum + 0 }' "$tmp")"
(( total <= max_bytes )) && exit 0

while read -r _ size file && (( total > max_bytes )); do
  [[ -n "$size" && "$size" =~ ^[0-9]+$ && -n "$file" ]] || continue
  if rm -f -- "$file"; then
    total=$((total - size))
  fi
done < "$tmp"
