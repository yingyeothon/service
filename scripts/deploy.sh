#!/bin/bash
# Usage: scripts/deploy.sh <auth|console|topic|match> <dev|prod> [extra serverless args, e.g. --param debugHooks=1]
set -euo pipefail
SERVICE="${1:?service}"; STAGE="${2:?stage}"
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
cd "$(dirname "$0")/.."
# Services bundle packages from their dist/, so always rebuild them first.
pnpm -r --filter "./packages/**" build
cd "services/${SERVICE}"
shift 2
pnpm exec serverless deploy --stage "${STAGE}" --region ap-northeast-2 "$@"
