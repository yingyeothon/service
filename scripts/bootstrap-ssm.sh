#!/bin/bash
# Uploads machine-local credentials to SSM so serverless.yml can resolve
# ${ssm:/yyt-service/<stage>/<service>/<key>}. Run once per stage (and again after rotation).
#
# Usage: scripts/bootstrap-ssm.sh <dev|prod> [service...]   (default: console auth topic match)
# Input: local/env/<service>.<stage>.env (gitignored; layout in local/env.example).
# Keys per service: mysql-{host,port,database,user,password} redis-{host,port,user,password} redis-key-prefix.
# Stage-wide keys (kept from the previous layout, uploaded only when the env var is set):
#   DEBUG_KEY (dev only; generated when absent), GITHUB_CLIENT_ID/SECRET, ADMIN_GITHUB_LOGINS, SESSION_SECRET.
# dev only: auth's debug seeding hook writes the console DB, so console.dev.env's MySQL account is also
#   published as /yyt-service/dev/auth/debug-mysql-{user,password} (docs/decisions.md "디버그 시드").
# Legacy /yyt-service/<stage>/upstash-* parameters are deleted.
# Logs (names only, never values) go to local/deploy/bootstrap-ssm.<stage>.log.
# Rotation: update local/env via yyt-stateful → run this → redeploy EVERY stack of the stage
#   (values are baked into Lambda env at deploy time) → only then revoke the old credentials.
set -euo pipefail
umask 077 # everything this script writes (logs, debug key, temp files) is owner-only
STAGE="${1:?stage (dev|prod)}"; shift || true
SERVICES=("$@"); [ ${#SERVICES[@]} -eq 0 ] && SERVICES=(console auth topic match)
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
cd "$(dirname "$0")/.."
mkdir -p local/deploy
LOG="local/deploy/bootstrap-ssm.${STAGE}.log"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
put() { # name value — the value goes through a 0600 temp file, never argv (visible in `ps`).
  if [ -z "$2" ]; then log "skip /yyt-service/${STAGE}/$1 (empty)"; return 0; fi
  printf '%s' "$2" > "$TMP"
  aws ssm put-parameter --name "/yyt-service/${STAGE}/$1" --type SecureString --value "file://${TMP}" --overwrite >/dev/null
  log "put /yyt-service/${STAGE}/$1"
}
envval() { # file VAR — plain KEY=value parse; the file is never sourced as shell.
  grep -E "^${2}=" "$1" | head -n1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'
}

for svc in "${SERVICES[@]}"; do
  f="local/env/${svc}.${STAGE}.env"
  [ -f "$f" ] || { echo "missing $f (see local/README.md)" >&2; exit 1; }
  [ "$(envval "$f" STAGE)" = "$STAGE" ] || { echo "$f: STAGE mismatch" >&2; exit 1; }
  for pair in mysql-host:MYSQL_HOST mysql-port:MYSQL_PORT mysql-database:MYSQL_DATABASE \
              mysql-user:MYSQL_USER mysql-password:MYSQL_PASSWORD redis-host:REDIS_HOST \
              redis-port:REDIS_PORT redis-user:REDIS_USER redis-password:REDIS_PASSWORD \
              redis-key-prefix:REDIS_KEY_PREFIX; do
    key="${pair%%:*}"; var="${pair##*:}"
    v="$(envval "$f" "$var")"
    [ -n "$v" ] || { echo "$f: $var is empty" >&2; exit 1; }
    put "${svc}/${key}" "$v"
  done
done

if [ "${STAGE}" = "dev" ]; then
  # Keep the existing key across re-runs (e.g. a MySQL rotation) so deployed
  # stacks and local/deploy/debug-key.dev stay valid; DEBUG_KEY=... forces a new one.
  if [ -z "${DEBUG_KEY:-}" ]; then
    DEBUG_KEY="$(aws ssm get-parameter --name "/yyt-service/dev/debug-key" --with-decryption --query Parameter.Value --output text 2>/dev/null || true)"
  fi
  DEBUG_KEY="${DEBUG_KEY:-$(openssl rand -hex 24)}"
  put debug-key "${DEBUG_KEY}"
  printf '%s\n' "${DEBUG_KEY}" > local/deploy/debug-key.dev
  chmod 600 local/deploy/debug-key.dev "$LOG" # umask does not fix pre-existing files
  log "debug-key written to local/deploy/debug-key.dev (for scripts/smoke/auth.mjs)"
  [ -f local/env/console.dev.env ] || { echo "missing local/env/console.dev.env (needed for auth debug seeding)" >&2; exit 1; }
  for var in MYSQL_USER MYSQL_PASSWORD; do
    v="$(envval local/env/console.dev.env "$var")"
    [ -n "$v" ] || { echo "console.dev.env: $var is empty" >&2; exit 1; }
    put "auth/debug-mysql-$(echo "$var" | tr 'A-Z_' 'a-z-')" "$v"
  done
fi
put github-client-id "${GITHUB_CLIENT_ID:-}"
put github-client-secret "${GITHUB_CLIENT_SECRET:-}"
put admin-github-logins "${ADMIN_GITHUB_LOGINS:-}"
put session-secret "${SESSION_SECRET:-}"

for legacy in upstash-url upstash-token; do
  if aws ssm delete-parameter --name "/yyt-service/${STAGE}/${legacy}" >/dev/null 2>&1; then
    log "deleted legacy /yyt-service/${STAGE}/${legacy}"
  fi
done
log "done stage=${STAGE} services=${SERVICES[*]}"
