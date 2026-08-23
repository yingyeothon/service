#!/bin/bash
# Usage: scripts/deploy.sh <env-file> [stage] [extra serverless args]
# The env file supplies JWT_*, MATCH_API_KEY and REDIS_* (see README.md); it is never committed.
set -euo pipefail
ENV_FILE="${1:?env file}"; STAGE="${2:-dev}"
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
cd "$(dirname "$0")/.."
set -a; . "$ENV_FILE"; set +a
shift; shift || true
serverless deploy --stage "$STAGE" --region ap-northeast-2 "$@"
