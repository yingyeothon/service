#!/usr/bin/env bash
# Switch one of a stage's CloudFront distributions off or on: the manual stop
# of docs/decisions.md *CDN cost guard and emergency stops*. A disabled
# distribution serves nothing and is not billed for requests or transfer;
# every object behind it is unreachable until it is switched on again.
#
# The CDN guard (console `cdnGuard`) never re-enables anything. When it sees a
# distribution enabled again it re-arms and counts traffic from that moment,
# so `on` here is also the reset after a guard trip.
#
# Usage: scripts/cdn-switch.sh <dev|prod> <artifact|path-host|site-host|console> <off|on> [--apply]
#   artifact   d.yyt.life / dev-d.yyt.life        (hand-made; SSM cdn-distribution-id)
#   path-host  g.yyt.life / dev-g.yyt.life        (hand-made; SSM site-distribution-id)
#   site-host  *.g.yyt.life / *.dev-g.yyt.life    (console stack SiteHostDistribution)
#   console    console.yyt.life / console-dev...  (console stack WebDistribution; also the console API)
# Dry run unless --apply. Needs AWS_PROFILE=yyt and jq. Idempotent: switching
# to the state it is already in changes nothing. Refuses a distribution whose
# aliases do not include the label's host (a wrong id in SSM).
set -euo pipefail

usage="usage: $0 <dev|prod> <artifact|path-host|site-host|console> <off|on> [--apply]"
STAGE="${1:?$usage}"
LABEL="${2:?$usage}"
WANT="${3:?$usage}"
APPLY="${4:-}"
case "$STAGE" in dev | prod) ;; *) echo "$usage" >&2; exit 2 ;; esac
case "$WANT" in
  off) ENABLED=false ;;
  on) ENABLED=true ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
if [ -n "$APPLY" ] && [ "$APPLY" != "--apply" ]; then echo "$usage" >&2; exit 2; fi
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
# SSM and the stack live here; CloudFront itself is global. Never exported:
# see rules/deployment.md on AWS_DEFAULT_REGION.
REGION=ap-northeast-2
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ssm() {
  aws ssm get-parameter --region "$REGION" --name "/yyt-service/${STAGE}/$1" \
    --query Parameter.Value --output text
}
stack_resource() {
  aws cloudformation describe-stack-resource --region "$REGION" \
    --stack-name "yyt-console-${STAGE}" --logical-resource-id "$1" \
    --query StackResourceDetail.PhysicalResourceId --output text
}
if [ "$STAGE" = prod ]; then D="d.yyt.life"; G="g.yyt.life"; C="console.yyt.life"
else D="dev-d.yyt.life"; G="dev-g.yyt.life"; C="console-dev.yyt.life"; fi
case "$LABEL" in
  artifact) DIST="$(ssm cdn-distribution-id)"; HOST="$D" ;;
  path-host) DIST="$(ssm site-distribution-id)"; HOST="$G" ;;
  site-host) DIST="$(stack_resource SiteHostDistribution)"; HOST="*.$G" ;;
  console) DIST="$(stack_resource WebDistribution)"; HOST="$C" ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
if [ -z "$DIST" ] || [ "$DIST" = "None" ]; then
  echo "${STAGE} has no ${LABEL} distribution" >&2
  exit 1
fi

aws cloudfront get-distribution-config --id "$DIST" >"$TMP/dist.json"
if ! jq -e --arg h "$HOST" \
  '(.DistributionConfig.Aliases.Items // []) | map(ascii_downcase) | index($h)' \
  "$TMP/dist.json" >/dev/null; then
  echo "refusing: the ${LABEL} distribution's aliases do not include ${HOST} (wrong id?)" >&2
  exit 1
fi
ETAG="$(jq -r .ETag "$TMP/dist.json")"
CURRENT="$(jq -r .DistributionConfig.Enabled "$TMP/dist.json")"
echo "stage=${STAGE} ${LABEL} (${HOST}): enabled=${CURRENT}, wanted ${ENABLED}"
if [ "$CURRENT" = "$ENABLED" ]; then
  echo "already ${WANT}; nothing to do"
  exit 0
fi
case "$LABEL:$WANT" in
  console:off) echo "note: the console API is behind this distribution too; the console goes down with it" ;;
  site-host:* | console:*) echo "note: stack-owned; a later console deploy that changes this resource sets it back to enabled" ;;
esac
jq --argjson e "$ENABLED" '.DistributionConfig | .Enabled = $e' "$TMP/dist.json" >"$TMP/config.json"

if [ "$APPLY" != "--apply" ]; then
  echo "[dry-run] would update-distribution (if-match ${ETAG}) to Enabled=${ENABLED}; pass --apply"
  exit 0
fi
aws cloudfront update-distribution --id "$DIST" --if-match "$ETAG" \
  --distribution-config "file://$TMP/config.json" \
  --query 'Distribution.{Status:Status,Enabled:DistributionConfig.Enabled}' --output json
echo "submitted; the change reaches every edge within minutes (Status turns Deployed)."
if [ "$WANT" = on ]; then
  echo "the CDN guard re-arms on its next run (every 5 minutes) and e-mails 're-armed'."
fi
