#!/bin/bash
# One-time per stage: stores the runtime secrets serverless.yml resolves via ${ssm:/yyt-service/<stage>/...}.
# Usage: UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... scripts/bootstrap-ssm.sh <dev|prod>
# Optional: DEBUG_KEY (dev only; generated when absent), GITHUB_CLIENT_ID/SECRET (console, 02), ADMIN_GITHUB_LOGINS, SESSION_SECRET.
set -euo pipefail
STAGE="${1:?stage}"
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
put() { # name value
  [ -z "$2" ] && return 0
  aws ssm put-parameter --name "/yyt-service/${STAGE}/$1" --type SecureString --value "$2" --overwrite >/dev/null
  echo "put /yyt-service/${STAGE}/$1"
}
put upstash-url "${UPSTASH_REDIS_REST_URL:?}"
put upstash-token "${UPSTASH_REDIS_REST_TOKEN:?}"
if [ "${STAGE}" = "dev" ]; then
  DEBUG_KEY="${DEBUG_KEY:-$(openssl rand -hex 24)}"
  put debug-key "${DEBUG_KEY}"
  echo "debug-key (dev only, for scripts/smoke/auth.mjs): ${DEBUG_KEY}"
fi
put github-client-id "${GITHUB_CLIENT_ID:-}"
put github-client-secret "${GITHUB_CLIENT_SECRET:-}"
put admin-github-logins "${ADMIN_GITHUB_LOGINS:-}"
put session-secret "${SESSION_SECRET:-}"
