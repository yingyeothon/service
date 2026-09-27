#!/usr/bin/env bash
# Stop serving one file, one site or one bundle while everything else stays up:
# the fine-grained manual stop of docs/decisions.md *CDN cost guard and
# emergency stops*. It adds the key (or `prefix/`) to the resources of a single
# `Deny s3:GetObject` statement (Sid `YytQuarantine`, principal `*`) in the
# bucket policy, then invalidates the matching path on the stage's
# distributions for that bucket, so every host answers 403 for it within
# minutes. `off` removes it again. The other policy statements are never
# touched (checked before writing); the old policy is backed up under the
# gitignored local/deploy/.
#
# What a quarantine stops: GET on every host (and a site move, whose copy
# reads the source). What it does not: uploads (stored, not served), deletes,
# name release and the sweeps.
#
# Find the hot object first: CloudFront console → Popular objects (no access
# logs needed). Then:
#   scripts/cdn-quarantine.sh <dev|prod> <site|artifact> <key | prefix/> <on|off> [--apply]
#   scripts/cdn-quarantine.sh <dev|prod> <site|artifact> list
# `site` is the static-site bucket (path host + per-site host); `artifact` is
# the catalog/asset bucket (d.yyt.life). A site's prefix is its slug or name
# (`my-game/`); a single file is its key (`my-game/big.bin`).
# Dry run unless --apply. Needs AWS_PROFILE=yyt and jq. Idempotent.
set -euo pipefail
# Policy backups stay private: those from before 2026-09-27 carry the retired
# origin-lock secret (a Referer condition).
umask 077

usage="usage: $0 <dev|prod> <site|artifact> <key | prefix/> <on|off> [--apply]  |  $0 <dev|prod> <site|artifact> list"
STAGE="${1:?$usage}"
KIND="${2:?$usage}"
TARGET="${3:?$usage}"
case "$STAGE" in dev | prod) ;; *) echo "$usage" >&2; exit 2 ;; esac
case "$KIND" in site | artifact) ;; *) echo "$usage" >&2; exit 2 ;; esac
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
# Byte-wise character ranges for the target check below.
export LC_ALL=C
REGION=ap-northeast-2
SID=YytQuarantine
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

ssm() {
  aws ssm get-parameter --region "$REGION" --name "/yyt-service/${STAGE}/$1" \
    --query Parameter.Value --output text
}
BUCKET="$(ssm "${KIND}-bucket")"
aws s3api get-bucket-policy --bucket "$BUCKET" --query Policy --output text >"$TMP/old.json"
jq -e . "$TMP/old.json" >/dev/null

listed() { # policy file → its quarantined keys and prefixes, as `off` takes them
  jq -r --arg sid "$SID" --arg p "arn:aws:s3:::${BUCKET}/" \
    '[.Statement[] | select(.Sid == $sid) | .Resource] | flatten | map(strings)
      | if length == 0 then "  (nothing quarantined)"
        else .[] | "  " + (ltrimstr($p) | rtrimstr("*")) end' "$1"
}
# An existing statement under the Sid must be exactly the Deny this script
# writes; anything else (an Allow, a condition, another action or principal,
# a NotResource) is refused rather than extended.
owned() {
  jq -e --arg sid "$SID" '
    all(.Statement[] | select(.Sid == $sid);
      .Effect == "Deny" and .Principal == "*" and .Action == "s3:GetObject"
      and has("Resource") and (has("NotResource") | not) and (has("Condition") | not))' \
    "$1" >/dev/null
}
if [ "$TARGET" = list ]; then
  listed "$TMP/old.json"
  owned "$TMP/old.json" ||
    echo "warning: the bucket policy has a ${SID} statement this script did not write; fix it by hand" >&2
  exit 0
fi

WANT="${4:?$usage}"
APPLY="${5:-}"
case "$WANT" in on | off) ;; *) echo "$usage" >&2; exit 2 ;; esac
if [ -n "$APPLY" ] && [ "$APPLY" != "--apply" ]; then echo "$usage" >&2; exit 2; fi
# The zip grammar's characters only: no leading `/` or `-`, no `..`, `//` or
# `*`, and at least one `/` — a bare `my-game` would be a single key and
# quarantine nothing (a site is `my-game/`). In the artifact bucket a target
# needs two segments, so `assets/` or `uploads/` cannot deny a whole catalog.
# POSIX brackets: a literal `]` goes first and `\` is not an escape inside them.
key_re='^[]A-Za-z0-9._@~+=()[][]A-Za-z0-9._@~+=()[/-]*$'
segments="$(tr -cd / <<<"${TARGET%/}" | wc -c)"
if ! [[ "$TARGET" =~ $key_re ]] ||
  [[ "$TARGET" == *..* ]] || [[ "$TARGET" == *//* ]] || [ "${#TARGET}" -lt 3 ] ||
  [[ "$TARGET" != */* ]] || { [ "$KIND" = artifact ] && [ "$segments" -lt 1 ]; }; then
  echo "refusing target '${TARGET}': a key, or a prefix ending in '/' (a site: 'my-game/'); no leading '/' or '-', no '..', '//' or '*'; in the artifact bucket at least two segments ('assets/<bundle>/', '<App>/<platform>/')" >&2
  exit 2
fi
if [[ "$TARGET" == */ ]]; then RESOURCE="arn:aws:s3:::${BUCKET}/${TARGET}*"; else RESOURCE="arn:aws:s3:::${BUCKET}/${TARGET}"; fi

# A principal that is an IAM unique id (AROA…, AIDA…) names a role or user
# that was deleted: AWS rejects every rewrite of such a policy ("Invalid
# principal"), so say so before trying, with the statements to remove.
dead="$(jq -r '[.Statement[] | select([.Principal | .. | strings] | any(test("^A(ROA|IDA)[0-9A-Z]{16,}$"))) | (.Sid // "(no Sid)")] | join(", ")' "$TMP/old.json")"
if [ -n "$dead" ]; then
  echo "refusing: statement(s) ${dead} of the ${KIND} bucket policy name deleted IAM principals; AWS rejects any rewrite of this policy until they are removed (how: rules/deployment.md → CDN emergency)" >&2
  exit 1
fi

if ! owned "$TMP/old.json"; then
  echo "refusing: the bucket policy has a ${SID} statement this script did not write; fix it by hand" >&2
  exit 1
fi

if [ "$WANT" = on ]; then
  jq --arg sid "$SID" --arg r "$RESOURCE" '
    if any(.Statement[]; .Sid == $sid) then
      .Statement |= map(if .Sid == $sid
        then .Resource = ([.Resource] | flatten | (. + [$r]) | unique) else . end)
    else
      .Statement += [{Sid: $sid, Effect: "Deny", Principal: "*", Action: "s3:GetObject", Resource: [$r]}]
    end' "$TMP/old.json" >"$TMP/new.json"
else
  jq --arg sid "$SID" --arg r "$RESOURCE" '
    .Statement |= (map(if .Sid == $sid
      then .Resource = ([.Resource] | flatten | map(select(. != $r))) else . end)
      | map(select(.Sid != $sid or (.Resource | length) > 0)))' "$TMP/old.json" >"$TMP/new.json"
fi

# Every other statement must come out byte-for-byte the same.
others() { jq -S --arg sid "$SID" '[.Statement[] | select(.Sid != $sid)]' "$1"; }
if [ "$(others "$TMP/old.json")" != "$(others "$TMP/new.json")" ]; then
  echo "refusing: the rewrite would change statements other than ${SID}" >&2
  exit 1
fi
# AWS hands a one-element Resource list back as a plain string: compare the
# Sid's resources as sorted lists, or a repeated `on` rewrites the same policy.
normalized() {
  jq -S --arg sid "$SID" \
    '.Statement |= map(if .Sid == $sid then .Resource = ([.Resource] | flatten | sort) else . end)' "$1"
}
WRITE=true
if [ "$(normalized "$TMP/old.json")" = "$(normalized "$TMP/new.json")" ]; then
  WRITE=false
  if [ "$WANT" = off ]; then
    echo "${TARGET} is not quarantined by itself in the ${KIND} bucket; nothing to write"
  else
    # Left by an `on` whose invalidation failed, perhaps: the edges would keep
    # serving the object until its TTL, so the invalidation runs again.
    echo "${TARGET} is already quarantined in the ${KIND} bucket policy; only the invalidation runs (again)"
  fi
else
  echo "stage=${STAGE} ${KIND} bucket: quarantine ${WANT} ${TARGET}"
  echo "resources after the change:"
  listed "$TMP/new.json"
fi
covering=""
if [ "$WANT" = off ]; then
  covering="$(jq -r --arg sid "$SID" --arg r "$RESOURCE" --arg p "arn:aws:s3:::${BUCKET}/" '
    [.Statement[] | select(.Sid == $sid) | .Resource] | flatten
    | map(select(endswith("*") and . != $r) | select(. as $q | $r | startswith($q | rtrimstr("*")))
      | ltrimstr($p) | rtrimstr("*"))
    | join(", ")' "$TMP/new.json")"
  if [ -n "$covering" ]; then echo "note: ${TARGET} stays denied by the quarantined prefix ${covering}"; fi
  if ! $WRITE; then exit 0; fi
fi

# Invalidate the directory the object lives in (one wildcard path, from the
# account's 1000 free per month): the path host and the per-site host key the
# cache by the same `/{label}/…` path the bucket uses.
if [[ "$TARGET" == */ ]]; then DIR="$TARGET"; else DIR="$(dirname -- "$TARGET")/"; fi
if [ "$DIR" = "./" ]; then INV="/${TARGET}"; else INV="/${DIR}*"; fi
DISTS=()
if [ "$KIND" = artifact ]; then
  DISTS+=("$(ssm cdn-distribution-id)")
else
  DISTS+=("$(ssm site-distribution-id)")
  if HOSTDIST="$(aws cloudformation describe-stack-resource --region "$REGION" \
    --stack-name "yyt-console-${STAGE}" --logical-resource-id SiteHostDistribution \
    --query StackResourceDetail.PhysicalResourceId --output text 2>"$TMP/err")"; then
    if [ -n "$HOSTDIST" ] && [ "$HOSTDIST" != "None" ]; then DISTS+=("$HOSTDIST"); fi
  elif ! grep -q "does not exist" "$TMP/err"; then
    # Not "this stage has no per-site host": say so, or it keeps serving the
    # object for its edge TTL (≤ 300 s) without anyone knowing why.
    echo "warning: could not look up the per-site host distribution; it will not be invalidated:" >&2
    cat "$TMP/err" >&2
  fi
fi

if [ "$APPLY" != "--apply" ]; then
  if $WRITE; then
    echo "[dry-run] would put-bucket-policy and, for 'on', invalidate ${INV} on ${#DISTS[@]} distribution(s); pass --apply"
  else
    echo "[dry-run] would invalidate ${INV} on ${#DISTS[@]} distribution(s); pass --apply"
  fi
  exit 0
fi
if $WRITE; then
  BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/local/deploy"
  mkdir -p "$BACKUP_DIR"
  # Two writes in one second must not overwrite the first backup.
  stamp="${BACKUP_DIR}/${STAGE}-${KIND}-bucket-policy-$(date -u +%Y%m%dT%H%M%SZ)"
  BACKUP="${stamp}.json"
  n=1
  while [ -e "$BACKUP" ]; do BACKUP="${stamp}-${n}.json"; n=$((n + 1)); done
  cp "$TMP/old.json" "$BACKUP"
  aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$TMP/new.json"
  echo "bucket policy written (previous one: ${BACKUP})"
fi
if [ "$WANT" = on ]; then
  for d in "${DISTS[@]}"; do
    aws cloudfront create-invalidation --distribution-id "$d" --paths "$INV" \
      --query Invalidation.Status --output text
  done
  echo "invalidated ${INV}; the hosts answer 403 for it once the invalidations land (a few minutes)"
elif [ -n "$covering" ]; then
  echo "still not served: the quarantined prefix ${covering} covers it"
else
  echo "served again on the next miss (cached 403s last seconds)"
fi
