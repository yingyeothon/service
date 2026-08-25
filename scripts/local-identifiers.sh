#!/bin/bash
# Builds local/identifiers.txt (gitignored): one grep -E pattern per stateful host / DB / account name
# found in local/env/*.env, used by the git hooks to refuse commits that mention them.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
out=local/identifiers.txt; tmp="$(mktemp)"; names="$(mktemp)"; all="$(mktemp)"
trap 'rm -f "$tmp" "$names" "$all"' EXIT
for f in local/env/*.env; do
  grep -E '^(MYSQL_HOST|REDIS_HOST|MYSQL_DATABASE|MYSQL_USER|REDIS_USER)=' "$f" | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'
done | grep -v '^$' | sort -u > "$names"
cp "$names" "$all"
# The stateful host carries a static Elastic IP, so the literal address is an identifier too.
# Resolve the names and add whatever they point at today; values that are not host names
# (DB and account names) simply resolve to nothing.
while read -r v; do
  getent ahostsv4 "$v" 2>/dev/null | awk '{print $1}' || true
done < "$names" | grep -E '^[0-9]+(\.[0-9]+){3}$' | sort -u >> "$all"
sort -u "$all" | sed -E 's/[][\.*^$+?(){}|\\/]/\\&/g' > "$tmp"
mv "$tmp" "$out"
echo "wrote $out ($(wc -l < "$out") patterns)"
