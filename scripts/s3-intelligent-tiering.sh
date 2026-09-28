#!/bin/bash
# The artifact bucket's one lifecycle rule (rules/serverless-aws.md, S3 section):
#   - every object moves to S3 Intelligent-Tiering at day 0. Deliberately
#     non-destructive: no expiration, and the optional asynchronous Archive
#     Access / Deep Archive Access tiers are NOT configured (no bucket-level
#     intelligent-tiering configuration is created), so every tier the bucket
#     can reach — Frequent, Infrequent, Archive Instant — stays
#     millisecond-access and a public download never waits on a restore;
#   - multipart uploads left incomplete for a day are aborted. Their parts are
#     invisible and billed; the console's sweep aborts what it knows about, and
#     this is the backstop (docs/decisions.md *Large asset uploads* #4). It
#     expires no object.
#
# The buckets are not CloudFormation resources (they pre-date the stacks and
# adopting them risks replacement), hence a script rather than a template.
# Usage: scripts/s3-intelligent-tiering.sh <stage> [check|--apply]
#   The bucket is the stage's SSM pointer `/yyt-service/<stage>/artifact-bucket`.
#   Without a mode: prints the live lifecycle and the configuration that would be put.
#   check: exits 1 unless the live rule is exactly this one (scripts/deploy.sh
#     console runs it and refuses a deploy without the abort backstop).
#   --apply: saves the raw live configuration to
#     local/deploy/lifecycle.<bucket>.<utc>.json, refuses if the bucket has any
#     rule with another ID (PutBucketLifecycleConfiguration replaces the whole
#     configuration: merge by hand first), then puts this rule and reads it back.
#     The put carries the live TransitionDefaultMinimumObjectSize: without the
#     flag S3 resets it to all_storage_classes_128K.
# Restoring a backup: the saved file is the raw GET output, so
#   jq '{Rules}' <backup> > /tmp/rules.json
#   aws s3api put-bucket-lifecycle-configuration --bucket <bucket> \
#     --lifecycle-configuration file:///tmp/rules.json \
#     --transition-default-minimum-object-size "$(jq -r .TransitionDefaultMinimumObjectSize <backup>)"
# and a backup that is `{}` (the bucket had no lifecycle) is restored with
#   aws s3api delete-bucket-lifecycle --bucket <bucket>
# Right after a put, a GET can still return the previous configuration for a
# few seconds: read (or `check`) again before calling an apply failed.
set -euo pipefail
STAGE="${1:?stage}"; MODE="${2:-}"
case "$STAGE" in dev|prod) ;; *) echo "stage must be dev or prod" >&2; exit 2 ;; esac
case "$MODE" in ""|check|--apply) ;; *) echo "mode must be check or --apply" >&2; exit 2 ;; esac
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
REGION="ap-northeast-2"
cd "$(dirname "$0")/.."
BUCKET="$(aws ssm get-parameter --region "$REGION" --name "/yyt-service/${STAGE}/artifact-bucket" \
  --query Parameter.Value --output text)"
[ -n "$BUCKET" ] && [ "$BUCKET" != "None" ] || { echo "SSM artifact-bucket is empty on ${STAGE}" >&2; exit 1; }
RULE_ID="intelligent-tiering-all"
RULES=$(cat <<EOF
{"Rules":[{"ID":"${RULE_ID}","Status":"Enabled","Filter":{"Prefix":""},
  "Transitions":[{"Days":0,"StorageClass":"INTELLIGENT_TIERING"}],
  "AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}}]}
EOF
)
# Only "no lifecycle" maps to {}; any other failure (bad profile, no such bucket,
# AccessDenied) must not be mistaken for an empty configuration.
ERR="$(mktemp)"; trap 'rm -f "$ERR"' EXIT
if ! LIVE="$(aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" --output json 2>"$ERR")"; then
  grep -q NoSuchLifecycleConfiguration "$ERR" || { cat "$ERR" >&2; exit 1; }
  LIVE='{}'
fi

if [ "$MODE" = "check" ]; then
  # The rule, exactly: one rule, our ID, enabled, whole bucket, day-0
  # Intelligent-Tiering, abort after a day, and never an expiration.
  if jq -e --arg id "$RULE_ID" '
      (.Rules // []) as $r
      | ($r | length) == 1
      and $r[0].ID == $id
      and $r[0].Status == "Enabled"
      and (($r[0].Filter // {}) | keys - ["Prefix"]) == []
      and (($r[0].Filter.Prefix // "") == "")
      and (($r[0].Prefix // "") == "")
      and ($r[0].Transitions == [{"Days":0,"StorageClass":"INTELLIGENT_TIERING"}])
      and ($r[0].AbortIncompleteMultipartUpload.DaysAfterInitiation == 1)
      and ($r[0].Expiration == null)
      and ($r[0].NoncurrentVersionExpiration == null)' <<<"$LIVE" >/dev/null; then
    echo "lifecycle ok on ${STAGE}"
    exit 0
  fi
  echo "refusing: the ${STAGE} artifact bucket lacks the lifecycle rule (scripts/s3-intelligent-tiering.sh ${STAGE} --apply)" >&2
  exit 1
fi

echo "stage: $STAGE"; echo "live lifecycle: $LIVE"; echo "proposed: $RULES"
[ "$MODE" = "--apply" ] || { echo "(dry run; pass --apply)"; exit 0; }
if [ "$(jq --arg id "$RULE_ID" '[(.Rules // [])[] | select(.ID != $id)] | length' <<<"$LIVE")" != 0 ]; then
  echo "bucket already has lifecycle rules; merge them into this script's rule by hand" >&2; exit 1
fi
MIN_SIZE="$(jq -r '.TransitionDefaultMinimumObjectSize // "all_storage_classes_128K"' <<<"$LIVE")"
umask 077; mkdir -p local/deploy
BACKUP="local/deploy/lifecycle.${BUCKET}.$(date -u +%Y%m%dT%H%M%SZ).json"
printf '%s\n' "$LIVE" > "$BACKUP"; echo "saved previous configuration to $BACKUP"
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
  --lifecycle-configuration "$RULES" --transition-default-minimum-object-size "$MIN_SIZE"
echo "applied; read back:"; aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET"
