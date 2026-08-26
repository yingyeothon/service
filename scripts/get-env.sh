#!/bin/bash
# Reverse of bootstrap-ssm.sh: rebuilds local/env/<service>.<stage>.env from SSM on a new machine.
# Usage: scripts/get-env.sh <dev|prod> [service...]   (default: console auth topic match state)
# Refuses to overwrite an existing file unless FORCE=1.
# For `console` it also restores the stage-wide keys that live in that file
# (github-client-*, admin-github-logins, and the optional ACL issuer pair), so a
# FORCE=1 re-pull cannot leave bootstrap-ssm.sh with an empty OAuth app.
set -euo pipefail
umask 077
STAGE="${1:?stage (dev|prod)}"; shift || true
SERVICES=("$@"); [ ${#SERVICES[@]} -eq 0 ] && SERVICES=(console auth topic match state)
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
  # A stage may legitimately have no state stack; every other service must exist.
  if [ "$svc" = state ] && [ -z "$(get mysql-host)" ]; then
    echo "skip $out (this stage has no state stack in SSM)"; continue
  fi
  tmp="$(mktemp)"; chmod 600 "$tmp"
  {
    echo "# ${svc} / ${STAGE} — pulled from SSM by scripts/get-env.sh on $(date -u +%F). Do not commit."
    echo "STAGE=${STAGE}"
    pairs=(MYSQL_HOST:mysql-host MYSQL_PORT:mysql-port MYSQL_DATABASE:mysql-database
           MYSQL_USER:mysql-user MYSQL_PASSWORD:mysql-password)
    # `state` holds no Redis connection, so it has no redis-* parameters to pull.
    [ "$svc" = state ] || pairs+=(REDIS_HOST:redis-host REDIS_PORT:redis-port REDIS_USER:redis-user
                                  REDIS_PASSWORD:redis-password REDIS_KEY_PREFIX:redis-key-prefix)
    for pair in "${pairs[@]}"; do
      v="$(get "${pair##*:}")"
      [ -n "$v" ] || { echo "$prefix${pair##*:} missing in SSM" >&2; rm -f "$tmp"; exit 1; }
      # Values are written verbatim and parsed (not sourced) by bootstrap-ssm.sh; refuse newlines anyway.
      case "$v" in *$'\n'*) echo "$prefix${pair##*:} contains a newline" >&2; rm -f "$tmp"; exit 1;; esac
      echo "${pair%%:*}=${v}"
    done
    # console only and optional (todo/16 B): absent means the stage has no
    # participant-credential issuer, which is a valid state, not an error.
    if [ "$svc" = console ]; then
      # The env var name is derived from the SSM key rather than written as a
      # `VAR:key` pair like the loop above. Written that way, the pair for the
      # ACL password is long enough to read as a credential assignment to
      # gitleaks, and weakening the scanner to fit a cosmetic collision is the
      # wrong trade.
      for k in redis-acl-user redis-acl-password; do
        v="$(get "$k")"
        [ -n "$v" ] || continue
        case "$v" in *$'\n'*) echo "$prefix$k contains a newline" >&2; rm -f "$tmp"; exit 1;; esac
        echo "$(echo "$k" | tr 'a-z-' 'A-Z_')=${v}"
      done
      # Stage-wide, but console's env file is where bootstrap-ssm.sh looks for
      # them: without these, a FORCE=1 re-pull silently produces a file that
      # then uploads *empty* github-client-* on the next bootstrap. (Learned the
      # hard way — a re-pull for verification wiped them.)
      stage_json="$(aws ssm get-parameters-by-path --path "/yyt-service/${STAGE}" --with-decryption --output json)"
      for k in github-client-id github-client-secret admin-github-logins; do
        v="$(echo "$stage_json" | jq -r --arg n "/yyt-service/${STAGE}/$k" '.Parameters[] | select(.Name==$n) | .Value')"
        [ -n "$v" ] || continue
        case "$v" in *$'\n'*) echo "/yyt-service/${STAGE}/$k contains a newline" >&2; rm -f "$tmp"; exit 1;; esac
        echo "$(echo "$k" | tr 'a-z-' 'A-Z_')=${v}"
      done
    fi
  } > "$tmp"
  mv "$tmp" "$out"
  echo "wrote $out"
done
