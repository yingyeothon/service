#!/bin/bash
# Moves every object of a pre-existing bucket to S3 Intelligent-Tiering via a
# lifecycle rule (todo-aws-cost-optimization.md B). Deliberately non-destructive:
# the rule has no expiration, and the optional asynchronous Archive Access /
# Deep Archive Access tiers are NOT configured (no bucket-level
# intelligent-tiering configuration is created), so every tier the bucket can
# reach — Frequent, Infrequent, Archive Instant — stays millisecond-access and
# a public download never waits on a restore.
#
# The buckets are not CloudFormation resources (they pre-date the stacks and
# adopting them risks replacement), hence a script rather than a template.
# Usage: scripts/s3-intelligent-tiering.sh <bucket> [--apply]
#   Without --apply: prints the current lifecycle and the rule that would be put.
#   With --apply: saves the live lifecycle to local/deploy/lifecycle.<bucket>.<utc>.json,
#   refuses if the bucket already has any lifecycle rule (merge by hand first —
#   PutBucketLifecycleConfiguration replaces the whole configuration), then puts
#   the single rule and reads it back.
set -euo pipefail
BUCKET="${1:?bucket}"; MODE="${2:-}"
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
cd "$(dirname "$0")/.."
RULE_ID="intelligent-tiering-all"
RULE=$(cat <<EOF
{"Rules":[{"ID":"${RULE_ID}","Status":"Enabled","Filter":{"Prefix":""},
  "Transitions":[{"Days":0,"StorageClass":"INTELLIGENT_TIERING"}]}]}
EOF
)
# Only "no lifecycle" maps to {}; any other failure (bad profile, no such bucket,
# AccessDenied) must not be mistaken for an empty configuration.
if ! LIVE="$(aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET" 2>&1)"; then
  grep -q NoSuchLifecycleConfiguration <<<"$LIVE" || { echo "$LIVE" >&2; exit 1; }
  LIVE='{}'
fi
echo "bucket: $BUCKET"; echo "live lifecycle: $LIVE"; echo "proposed: $RULE"
[ "$MODE" = "--apply" ] || { echo "(dry run; pass --apply)"; exit 0; }
if [ "$(jq --arg id "$RULE_ID" '[(.Rules // [])[] | select(.ID != $id)] | length' <<<"$LIVE")" != 0 ]; then
  echo "bucket already has lifecycle rules; merge them into this script's rule by hand" >&2; exit 1
fi
umask 077; mkdir -p local/deploy
BACKUP="local/deploy/lifecycle.${BUCKET}.$(date -u +%Y%m%dT%H%M%SZ).json"
printf '%s\n' "$LIVE" > "$BACKUP"; echo "saved previous configuration to $BACKUP"
aws s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" --lifecycle-configuration "$RULE"
echo "applied; read back:"; aws s3api get-bucket-lifecycle-configuration --bucket "$BUCKET"
