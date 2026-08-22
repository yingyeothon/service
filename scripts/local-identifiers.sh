#!/bin/bash
# Builds local/identifiers.txt (gitignored): one grep -E pattern per stateful host / DB / account name
# found in local/env/*.env, used by the git hooks to refuse commits that mention them.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
out=local/identifiers.txt; tmp="$(mktemp)"
for f in local/env/*.env; do
  grep -E '^(MYSQL_HOST|REDIS_HOST|MYSQL_DATABASE|MYSQL_USER|REDIS_USER)=' "$f" | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'
done | grep -v '^$' | sort -u | sed -E 's/[][\.*^$+?(){}|\\/]/\\&/g' > "$tmp"
mv "$tmp" "$out"
echo "wrote $out ($(wc -l < "$out") patterns)"
