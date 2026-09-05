#!/usr/bin/env bash
# Attach the artifact CDN's custom response-headers policy (CORS `*` written at
# delivery via OriginOverride, plus the usual security headers) to a stage's
# hand-built distribution, then invalidate `/*` so every cached variant is
# re-delivered with the header.
#
# Why: the managed `CORS-and-SecurityHeadersPolicy` has `OriginOverride: false`,
# so a variant cached from an Origin-less server-side fetch (the game Lambda
# reading MAP_URL) is delivered to browsers without Access-Control-Allow-Origin
# forever (`immutable`). See rules/deployment.md.
#
# Usage: scripts/cdn-cors-policy.sh <stage> [--dry-run]
# Needs: AWS_PROFILE=yyt, jq. Idempotent: re-running re-attaches and re-invalidates.
set -euo pipefail

STAGE="${1:?usage: $0 <stage> [--dry-run]}"
DRY="${2:-}"
POLICY_NAME="yyt-artifact-cdn-headers"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DIST="$(aws ssm get-parameter --name "/yyt-service/${STAGE}/cdn-distribution-id" \
  --query Parameter.Value --output text)"

policy_id() {
  aws cloudfront list-response-headers-policies --type custom \
    --query "ResponseHeadersPolicyList.Items[?ResponseHeadersPolicy.ResponseHeadersPolicyConfig.Name=='${POLICY_NAME}'].ResponseHeadersPolicy.Id" \
    --output text
}

POLICY_ID="$(policy_id)"
if [ -z "$POLICY_ID" ] || [ "$POLICY_ID" = "None" ]; then
  cat > "$TMP/policy.json" <<JSON
{
  "Name": "${POLICY_NAME}",
  "Comment": "Artifact CDN: CORS * written at delivery (origin override) plus security headers",
  "CorsConfig": {
    "AccessControlAllowOrigins": { "Quantity": 1, "Items": ["*"] },
    "AccessControlAllowHeaders": { "Quantity": 1, "Items": ["*"] },
    "AccessControlAllowMethods": { "Quantity": 3, "Items": ["GET", "HEAD", "OPTIONS"] },
    "AccessControlAllowCredentials": false,
    "AccessControlExposeHeaders": { "Quantity": 2, "Items": ["ETag", "Content-Length"] },
    "AccessControlMaxAgeSec": 86400,
    "OriginOverride": true
  },
  "SecurityHeadersConfig": {
    "ContentTypeOptions": { "Override": true },
    "FrameOptions": { "Override": false, "FrameOption": "SAMEORIGIN" },
    "ReferrerPolicy": { "Override": false, "ReferrerPolicy": "strict-origin-when-cross-origin" },
    "StrictTransportSecurity": { "Override": false, "AccessControlMaxAgeSec": 31536000 }
  }
}
JSON
  if [ "$DRY" = "--dry-run" ]; then
    echo "[dry-run] would create response-headers policy ${POLICY_NAME}"
    POLICY_ID="<new>"
  else
    POLICY_ID="$(aws cloudfront create-response-headers-policy \
      --response-headers-policy-config "file://$TMP/policy.json" \
      --query ResponseHeadersPolicy.Id --output text)"
    echo "created policy ${POLICY_NAME} = ${POLICY_ID}"
  fi
else
  echo "policy ${POLICY_NAME} exists = ${POLICY_ID}"
fi

aws cloudfront get-distribution-config --id "$DIST" > "$TMP/dist.json"
ETAG="$(jq -r .ETag "$TMP/dist.json")"
CURRENT="$(jq -r '.DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId // "-"' "$TMP/dist.json")"
echo "stage=${STAGE} current ResponseHeadersPolicyId=${CURRENT}"
jq --arg id "$POLICY_ID" '.DistributionConfig | .DefaultCacheBehavior.ResponseHeadersPolicyId = $id' \
  "$TMP/dist.json" > "$TMP/config.json"

if [ "$DRY" = "--dry-run" ]; then
  echo "[dry-run] would update-distribution (if-match ${ETAG}) and invalidate /*"
  exit 0
fi

aws cloudfront update-distribution --id "$DIST" --if-match "$ETAG" \
  --distribution-config "file://$TMP/config.json" \
  --query 'Distribution.{Status:Status,RHP:DistributionConfig.DefaultCacheBehavior.ResponseHeadersPolicyId}' --output json
INV="$(aws cloudfront create-invalidation --distribution-id "$DIST" --paths "/*" \
  --query Invalidation.Id --output text)"
echo "invalidation ${INV} submitted; wait for it, then verify from a browser:"
echo "  node scripts/smoke/cdn-cors-browser.mjs <cdn url of an object the game Lambda has fetched>"
