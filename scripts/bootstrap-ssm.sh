#!/bin/bash
# Uploads machine-local credentials to SSM so serverless.yml can resolve
# ${ssm:/yyt-service/<stage>/<service>/<key>}. Run once per stage (and again after rotation).
#
# Usage: scripts/bootstrap-ssm.sh <dev|prod> [service...]   (default: console auth topic match)
# Input: local/env/<service>.<stage>.env (gitignored; layout in local/env.example).
# Keys per service: mysql-{host,port,database,user,password} redis-{host,port,user,password} redis-key-prefix.
# console only (optional): redis-acl-{user,password} — the account that mints per-channel
#   participant Redis credentials (todo/16 §B). Absent = those routes answer 503.
# Stage-wide keys (uploaded only when set): DEBUG_KEY (dev only; generated when absent), SESSION_SECRET,
#   and GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET/ADMIN_GITHUB_LOGINS — taken from the shell environment, else from
#   local/env/console.<stage>.env (console owns the operator OAuth app).
# Stage-wide, gateway (todo/14): gateway-token is generated when absent and kept across re-runs
#   (GATEWAY_TOKEN=... rotates it), and written to local/deploy/gateway-token.<stage>.
#   gateway-ws-url is NOT touched here — it is a public domain, set by hand as a plain String
#   parameter once the gateway resolves; while unset, lobby/q channel views omit `wsUrl`.
# Always: cloudfront-cert-arn (looked up from ACM us-east-1, used by services/console CloudFront).
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
CONSOLE_ENV="local/env/console.${STAGE}.env"
# Console-only: the Redis account that mints per-channel participant credentials
# (todo/16 §B). Optional — while unset, /channels/{id}/redis-user answers 503 and
# nothing else changes. Created on the host by yyt-stateful, never by this repo.
if [ -f "$CONSOLE_ENV" ]; then
  acl_user="$(envval "$CONSOLE_ENV" REDIS_ACL_USER)"
  acl_pw="$(envval "$CONSOLE_ENV" REDIS_ACL_PASSWORD)"
  # Both or neither. `put` skips an empty value silently, so a half-set pair
  # would upload the username, leave the password absent, and produce a stage
  # where every credential route 503s while SSM visibly holds a user name.
  if { [ -n "$acl_user" ] && [ -z "$acl_pw" ]; } || { [ -z "$acl_user" ] && [ -n "$acl_pw" ]; }; then
    echo "$CONSOLE_ENV: set both REDIS_ACL_USER and REDIS_ACL_PASSWORD, or neither" >&2; exit 1
  fi
  put console/redis-acl-user "$acl_user"
  put console/redis-acl-password "$acl_pw"
  # Removing the issuer needs an explicit delete: `put` never deletes, so
  # clearing the env file alone would leave the stale pair in SSM and the next
  # deploy would bake a revoked credential back into the Lambda.
  if [ -z "$acl_user" ]; then
    for k in redis-acl-user redis-acl-password; do
      if aws ssm delete-parameter --name "/yyt-service/${STAGE}/console/${k}" >/dev/null 2>&1; then
        log "deleted /yyt-service/${STAGE}/console/${k} (issuer unset locally)"
      fi
    done
  fi
fi
for var in GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET ADMIN_GITHUB_LOGINS; do
  if [ -z "${!var:-}" ] && [ -f "$CONSOLE_ENV" ]; then
    declare "$var=$(envval "$CONSOLE_ENV" "$var")"
  fi
done
if [ "${STAGE}" = "prod" ] && [ -z "${ADMIN_GITHUB_LOGINS:-}" ] && ! aws ssm get-parameter --name "/yyt-service/prod/admin-github-logins" >/dev/null 2>&1; then
  echo "prod needs ADMIN_GITHUB_LOGINS (otherwise nobody can approve console members)" >&2; exit 1
fi
put github-client-id "${GITHUB_CLIENT_ID:-}"
put github-client-secret "${GITHUB_CLIENT_SECRET:-}"
put admin-github-logins "${ADMIN_GITHUB_LOGINS:-}"
put session-secret "${SESSION_SECRET:-}"

# Realtime gateway (todo/14): the console checks GATEWAY_TOKEN on
# GET /gw/channels/{id}. Generated once per stage and kept across re-runs, the
# same way as debug-key; GATEWAY_TOKEN=... forces a new one (then redeploy
# console AND the gateway). It must be >= 32 chars — the console disables the
# route and logs an error below that, so generate rather than hand-pick.
if [ -z "${GATEWAY_TOKEN:-}" ]; then
  GATEWAY_TOKEN="$(aws ssm get-parameter --name "/yyt-service/${STAGE}/gateway-token" --with-decryption --query Parameter.Value --output text 2>/dev/null || true)"
fi
GATEWAY_TOKEN="${GATEWAY_TOKEN:-gw_$(openssl rand -hex 32)}"
if [ "${#GATEWAY_TOKEN}" -lt 32 ]; then
  echo "GATEWAY_TOKEN must be at least 32 characters (console refuses shorter ones)" >&2; exit 1
fi
put gateway-token "${GATEWAY_TOKEN}"
printf '%s\n' "${GATEWAY_TOKEN}" > "local/deploy/gateway-token.${STAGE}"
chmod 600 "local/deploy/gateway-token.${STAGE}"
log "gateway-token written to local/deploy/gateway-token.${STAGE} (hand it to the gateway; scripts/smoke/console.mjs reads it)"
# GATEWAY_WS_URL is a public domain, not a secret, and is set by hand once the
# gateway actually resolves:
#   aws ssm put-parameter --name /yyt-service/<stage>/gateway-ws-url --type String --value wss://gw…
# Until then it stays unset and lobby/q views omit `wsUrl` entirely.

# CloudFront (console SPA) needs the us-east-1 certificate covering *.yyt.life;
# serverless.yml reads its ARN from SSM so no account-specific ARN lives in git.
CERT_ARN="$(aws acm list-certificates --region us-east-1 --certificate-statuses ISSUED \
  --query "CertificateSummaryList[?contains(SubjectAlternativeNameSummaries, '*.yyt.life')].CertificateArn | [0]" --output text)"
if [ -n "$CERT_ARN" ] && [ "$CERT_ARN" != "None" ]; then
  put cloudfront-cert-arn "$CERT_ARN"
else
  log "WARN no ISSUED us-east-1 ACM certificate for *.yyt.life; console deploy needs cloudfront-cert-arn (todo/07-infra.md)"
fi

for legacy in upstash-url upstash-token; do
  if aws ssm delete-parameter --name "/yyt-service/${STAGE}/${legacy}" >/dev/null 2>&1; then
    log "deleted legacy /yyt-service/${STAGE}/${legacy}"
  fi
done
log "done stage=${STAGE} services=${SERVICES[*]}"
