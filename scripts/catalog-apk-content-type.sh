#!/bin/bash
# One-off backfill (docs/decisions.md *Catalog share links and install bridge*
# #6, todo/80): every catalog `.apk` under `apps/` is stored as
# `application/vnd.android.package-archive`. New commits set it; objects
# committed before 2026-10-27 carry the uploader's generic type, so this
# copies each one onto itself with the new type (MetadataDirective REPLACE),
# keeping its storage class, Cache-Control and Content-Disposition. Same key,
# same bytes, same ETag: every stored URL stays valid. Idempotent.
# Usage: scripts/catalog-apk-content-type.sh <stage> [--apply]
#   Without --apply: lists what would change. The bucket is the stage's SSM
#   pointer `/yyt-service/<stage>/artifact-bucket`. CDN copies cached with the
#   old type expire on their own TTL; nothing is invalidated.
set -euo pipefail
STAGE="${1:?stage}"
MODE="${2:-}"
REGION=ap-northeast-2
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
TYPE=application/vnd.android.package-archive
BUCKET="$(aws ssm get-parameter --region "$REGION" --name "/yyt-service/${STAGE}/artifact-bucket" \
  --query Parameter.Value --output text)"
[[ -n "$BUCKET" && "$BUCKET" != "None" ]] || { echo "no artifact-bucket for ${STAGE}" >&2; exit 1; }

# Listed up front so a failed listing stops the script (a process
# substitution would hide its exit status); `.apk` in any case, as the
# commit matches it.
KEYS="$(aws s3api list-objects-v2 --region "$REGION" --bucket "$BUCKET" --prefix apps/ \
  --output json | jq -r '.Contents // [] | .[].Key | select(test("\\.apk$"; "i"))')"

changed=0; ok=0
while IFS= read -r key; do
  [[ -z "$key" || "$key" == "None" ]] && continue
  head="$(aws s3api head-object --region "$REGION" --bucket "$BUCKET" --key "$key" --output json)"
  ct="$(jq -r '.ContentType // ""' <<<"$head")"
  if [[ "$ct" == "$TYPE" ]]; then ok=$((ok + 1)); continue; fi
  echo "${key}  ${ct:-<none>} -> ${TYPE}"
  changed=$((changed + 1))
  [[ "$MODE" == "--apply" ]] || continue
  args=(--metadata-directive REPLACE --content-type "$TYPE")
  sc="$(jq -r '.StorageClass // ""' <<<"$head")"
  [[ -n "$sc" ]] && args+=(--storage-class "$sc")
  cc="$(jq -r '.CacheControl // ""' <<<"$head")"
  [[ -n "$cc" ]] && args+=(--cache-control "$cc")
  cd="$(jq -r '.ContentDisposition // ""' <<<"$head")"
  [[ -n "$cd" ]] && args+=(--content-disposition "$cd")
  aws s3api copy-object --region "$REGION" --bucket "$BUCKET" --key "$key" \
    --copy-source "${BUCKET}/$(jq -rn --arg k "$key" '$k|@uri' | sed 's/%2F/\//g')" \
    "${args[@]}" --output text --query CopyObjectResult.ETag >/dev/null
done <<<"$KEYS"

echo "already set: ${ok}; $([[ "$MODE" == "--apply" ]] && echo updated || echo "would update"): ${changed}"
