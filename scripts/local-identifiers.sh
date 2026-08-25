#!/bin/bash
# Builds local/identifiers.txt (gitignored): one grep -E pattern per stateful host / DB / account name
# found in local/env/*.env, plus the public addresses those host names resolve to and any extra names
# listed in local/identifiers.extra.txt. The git hooks refuse commits/pushes that mention them.
# Refuses to write a weakened list: a blank, short, or address-less result would silently stop guarding.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
out=local/identifiers.txt; tmp="$(mktemp)"; names="$(mktemp)"; all="$(mktemp)"
trap 'rm -f "$tmp" "$names" "$all"' EXIT
for f in local/env/*.env; do
  grep -E '^(MYSQL_HOST|REDIS_HOST|MYSQL_DATABASE|MYSQL_USER|REDIS_USER)=' "$f" | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'
done | grep -vE '^[[:space:]]*$' | sort -u > "$names"
# Other public names for the same box that no env file carries (one per line, # comments allowed).
if [ -f local/identifiers.extra.txt ]; then
  grep -vE '^[[:space:]]*(#|$)' local/identifiers.extra.txt >> "$names" || true
  sort -u -o "$names" "$names"
fi
cp "$names" "$all"
# The stateful host carries a static Elastic IP, so the literal address is an identifier too.
# Resolve the names and add what they point at today; values that are not host names (DB and
# account names) simply resolve to nothing. Loopback/private/link-local answers are dropped:
# a resolver that hijacks NXDOMAIN would otherwise turn 127.0.0.1 into a pattern that refuses
# every commit touching a test fixture.
ips=$(
  while read -r v; do
    getent ahostsv4 "$v" 2>/dev/null | awk '{print $1}' || true
  done < "$names" |
    grep -E '^[0-9]+(\.[0-9]+){3}$' |
    grep -vE '^(0\.|127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' |
    sort -u || true
)
if [ -z "$ips" ]; then
  echo "local-identifiers: no host name resolved to a public address (DNS down?) — keeping the existing $out" >&2
  exit 1
fi
printf '%s\n' "$ips" >> "$all"
sort -u "$all" | sed -E 's/[][\.*^$+?(){}|\\/]/\\&/g' > "$tmp"
# Give address patterns digit boundaries so an address cannot match inside a longer digit run
# (203.0.113.10 must not be found inside 1203.0.113.104).
sed -i -E 's/^([0-9]+(\\\.[0-9]+){3})$/(^|[^0-9.])\1([^0-9.]|$)/' "$tmp"
# Let every dot tolerate a preceding backslash, so an identifier written in escaped form inside a
# regex or a comment is caught too - that is how the address leaked past the guard once already.
sed -i -E 's/\\\./\\\\?\\./g' "$tmp"
short=$(grep -cE '^.{0,7}$' "$tmp" || true)
if [ ! -s "$tmp" ] || [ "${short:-0}" -gt 0 ]; then
  echo "local-identifiers: refusing to write $out — ${short:-0} pattern(s) under 8 characters would match almost every diff" >&2
  exit 1
fi
mv "$tmp" "$out"
echo "wrote $out ($(wc -l < "$out") patterns, $(printf '%s\n' "$ips" | wc -l) resolved address(es))"
