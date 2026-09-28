#!/bin/bash
# Usage: scripts/deploy.sh <auth|console|topic|match|state> <dev|prod> [extra serverless args, e.g. --param debugHooks=1]
# Deploy console before state when a change spans both: console owns every migration,
# and `state` reads a table console's migration creates.
set -euo pipefail
SERVICE="${1:?service}"; STAGE="${2:?stage}"
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
cd "$(dirname "$0")/.."
# The per-site host reads the site bucket through origin access control:
# refuse a console deploy while the bucket would not let it in
# (docs/decisions.md *CDN cost guard* §11, scripts/origin-oac.sh).
if [[ "${SERVICE}" == "console" ]]; then
  scripts/origin-oac.sh "${STAGE}" check-deploy
  # Abandoned multipart parts are invisible and billed: the artifact bucket's
  # lifecycle rule is the backstop behind the console's own sweep
  # (docs/decisions.md *Large asset uploads* #4).
  scripts/s3-intelligent-tiering.sh "${STAGE}" check
fi
# Services bundle packages from their dist/, so always rebuild them first.
pnpm -r --filter "./packages/**" build
# Console owns the schema: apply pending Prisma migrations before deploying it.
if [[ "${SERVICE}" == "console" ]]; then
  scripts/migrate.sh "${STAGE}"
fi
cd "services/${SERVICE}"
shift 2
pnpm exec serverless deploy --stage "${STAGE}" --region ap-northeast-2 "$@"
