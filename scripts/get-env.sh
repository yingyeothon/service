#!/bin/bash
# Reverse of bootstrap-ssm.sh: rebuilds local/env/<service>.<stage>.env from SSM on a new machine.
# Usage: scripts/get-env.sh <dev|prod> [service...]   (default: console auth topic match)
# Refuses to overwrite an existing file unless FORCE=1.
set -euo pipefail
umask 077
STAGE="${1:?stage (dev|prod)}"; shift || true
SERVICES=("$@"); [ ${#SERVICES[@]} -eq 0 ] && SERVICES=(console auth topic match)
command -v jq >/dev/null || { echo "get-env.sh: jq is required" >&2; exit 1; }
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
cd "$(dirname "$0")/.."
mkdir -p -m 700 local/env
for svc in "${SERVICES[@]}"; do
  out="local/env/${svc}.${STAGE}.env"
  if [ -f "$out" ] && [ "${FORCE:-0}" != "1" ]; then echo "skip $out (exists; FORCE=1 to overwrite)"; continue; fi
  prefix="/yyt-service/${STAGE}/${svc}/"
  json="$(aws ssm get-parameters-by-path --path "$prefix" --with-decryption --output json)"
  get() { echo "$json" | jq -r --arg n "${prefix}$1" '.Parameters[] | select(.Name==$n) | .Value'; }
  tmp="$(mktemp)"; chmod 600 "$tmp"
  {
    echo "# ${svc} / ${STAGE} — pulled from SSM by scripts/get-env.sh on $(date -u +%F). Do not commit."
    echo "STAGE=${STAGE}"
    for pair in MYSQL_HOST:mysql-host MYSQL_PORT:mysql-port MYSQL_DATABASE:mysql-database MYSQL_USER:mysql-user \
                MYSQL_PASSWORD:mysql-password REDIS_HOST:redis-host REDIS_PORT:redis-port REDIS_USER:redis-user \
                REDIS_PASSWORD:redis-password REDIS_KEY_PREFIX:redis-key-prefix; do
      v="$(get "${pair##*:}")"
      [ -n "$v" ] || { echo "$prefix${pair##*:} missing in SSM" >&2; rm -f "$tmp"; exit 1; }
      # Values are written verbatim and parsed (not sourced) by bootstrap-ssm.sh; refuse newlines anyway.
      case "$v" in *$'\n'*) echo "$prefix${pair##*:} contains a newline" >&2; rm -f "$tmp"; exit 1;; esac
      echo "${pair%%:*}=${v}"
    done
  } > "$tmp"
  mv "$tmp" "$out"
  echo "wrote $out"
done
