#!/bin/bash
# Builds apps/console-web and publishes it to the console stack's SPA bucket
# (`yyt-console-web-<stage>`, key prefix `ui/`), then invalidates CloudFront.
# Usage: scripts/deploy-web.sh <dev|prod>
# Requires the console stack of that stage to be deployed (scripts/deploy.sh console <stage>).
set -euo pipefail
STAGE="${1:?stage (dev|prod)}"
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
cd "$(dirname "$0")/.."

STACK="yyt-console-${STAGE}"
output() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text; }
BUCKET="$(output WebBucketName)"; DIST="$(output WebDistributionId)"
for v in "$BUCKET" "$DIST"; do
  [ -n "$v" ] && [ "$v" != "None" ] || { echo "stack $STACK lacks WebBucketName/WebDistributionId outputs; deploy console first" >&2; exit 1; }
done

pnpm --filter @yyt/console-web build
DIST_DIR="apps/console-web/dist"
[ -f "$DIST_DIR/index.html" ] || { echo "missing $DIST_DIR/index.html" >&2; exit 1; }

# Hashed assets are immutable; index.html must always be revalidated so a new
# release is picked up on the next navigation. Source maps stay out of prod.
# No --delete: the previous index.html keeps being served until the
# invalidation lands, and already-open tabs lazy-load old chunks, so stale
# hashed files stay (they are tiny); prune by hand if the bucket ever matters.
MAP_ARGS=(); [ "$STAGE" = "prod" ] && MAP_ARGS=(--exclude "*.map")
aws s3 sync "$DIST_DIR/assets" "s3://${BUCKET}/ui/assets" \
  --cache-control "public, max-age=31536000, immutable" "${MAP_ARGS[@]}"
# Anything else Vite emits at the top level (public/ files) is not hashed.
aws s3 sync "$DIST_DIR" "s3://${BUCKET}/ui" --exclude "assets/*" --exclude index.html \
  --cache-control "no-cache" "${MAP_ARGS[@]}"
aws s3 cp "$DIST_DIR/index.html" "s3://${BUCKET}/ui/index.html" \
  --cache-control "no-cache" --content-type "text/html; charset=utf-8"
# The CloudFront cache key is computed after the viewer-request Function runs,
# so every SPA route shares the /ui/index.html entry: these paths drop it all.
aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/ui" "/ui/" "/ui/index.html" --query 'Invalidation.Id' --output text
echo "published ${DIST_DIR} -> s3://${BUCKET}/ui (distribution ${DIST})"
