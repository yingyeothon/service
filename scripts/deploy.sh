#!/bin/bash
# Usage: scripts/deploy.sh <auth|console|topic|match> <dev|prod> [extra serverless args, e.g. --param debugHooks=1]
set -euo pipefail
SERVICE="${1:?service}"; STAGE="${2:?stage}"
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
cd "$(dirname "$0")/.."
# Services bundle packages from their dist/, so always rebuild them first.
pnpm -r --filter "./packages/**" build
# The sqlite layer zip is git-ignored; build it once per clone.
[ -f layers/better-sqlite3/better-sqlite3-arm64.zip ] || layers/better-sqlite3/build.sh
cd "services/${SERVICE}"
shift 2
pnpm exec serverless deploy --stage "${STAGE}" --region ap-northeast-2 "$@"
