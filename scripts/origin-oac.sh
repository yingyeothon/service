#!/usr/bin/env bash
# Private S3 origins (docs/decisions.md *CDN cost guard and emergency stops*
# §11): every CloudFront distribution in front of the site and artifact
# buckets reads the bucket's REST endpoint through origin access control, and
# the buckets let nobody else read. A direct S3 read is 403, so neither the
# CDN guard nor `cdn-switch.sh` can be bypassed by knowing a bucket name.
#
# Usage: scripts/origin-oac.sh <dev|prod> <status|apply|revert|check-deploy> [--apply]
#   status        per bucket: who may read, Block Public Access; per distribution:
#                 origin, access control, function, origin headers
#   apply         1. each bucket policy lets the stage's distributions in front of
#                    it read (Sid YytCloudFrontRead; replaces an older CloudFront
#                    statement naming only those distributions)
#                 2. needs the console stack's CdnOriginAccessControl and edge
#                    functions (deploy console after 1): the hand-made path host
#                    and artifact CDN read the REST endpoint through the control,
#                    with their viewer-request function; waits until Deployed
#                 3. once every distribution in front of a bucket reads through a
#                    control and is Deployed: anonymous statements removed, Block
#                    Public Access on (BlockPublicAcls stays as it is on the prod
#                    artifact bucket: the legacy uploader sends public-read), and
#                    the retired SSM origin-secret deleted
#                 4. probes; a mismatch exits 1 and names `revert`
#   revert        the way back if something breaks: hand-made distributions whose
#                 bucket has website hosting read the public website endpoint
#                 again, BlockPublicPolicy/RestrictPublicBuckets off, an anonymous
#                 read statement — direct S3 reads work again, past the CDN guard
#                 and cdn-switch, until the next apply. Every hand-made
#                 distribution loses the console stack's function, so a console
#                 rollback can delete it. The per-site host keeps its control.
#   check-deploy  exit 1 when the stack's per-site host exists and the site bucket
#                 does not let it read (scripts/deploy.sh console runs this)
# Dry run unless --apply. Idempotent. Needs AWS_PROFILE=yyt, jq and curl.
# Policy and distribution backups go to the gitignored local/deploy/ (0600).
set -euo pipefail
umask 077

usage="usage: $0 <dev|prod> <status|apply|revert|check-deploy> [--apply]"
STAGE="${1:?$usage}"
MODE="${2:?$usage}"
APPLY="${3:-}"
case "$STAGE" in dev | prod) ;; *) echo "$usage" >&2; exit 2 ;; esac
case "$MODE" in status | apply | revert | check-deploy) ;; *) echo "$usage" >&2; exit 2 ;; esac
if [ -n "$APPLY" ] && [ "$APPLY" != "--apply" ]; then echo "$usage" >&2; exit 2; fi
DRY=true
[ "$APPLY" = "--apply" ] && DRY=false
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
# SSM, S3 and the stack live here; CloudFront is global. Never exported
# (rules/deployment.md on AWS_DEFAULT_REGION).
REGION=ap-northeast-2
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SID=YytCloudFrontRead
PUBLIC_SID=YytPublicRead
BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/local/deploy"
if [ "$STAGE" = prod ]; then D="d.yyt.life"; G="g.yyt.life"; else D="dev-d.yyt.life"; G="dev-g.yyt.life"; fi

ssm() {
  aws ssm get-parameter --region "$REGION" --name "/yyt-service/${STAGE}/$1" \
    --query Parameter.Value --output text
}
# A missing stack or resource is ""; any other error stops the script.
stack_resource() {
  local out
  if out="$(aws cloudformation describe-stack-resource --region "$REGION" \
    --stack-name "yyt-console-${STAGE}" --logical-resource-id "$1" \
    --query StackResourceDetail.PhysicalResourceId --output text 2>"$TMP/err")"; then
    [ "$out" = None ] && out=""
    echo "$out"
  elif grep -q "does not exist" "$TMP/err"; then
    echo ""
  else
    cat "$TMP/err" >&2
    return 1
  fi
}
function_arn() { # name → ARN of its LIVE stage, "" when it does not exist
  local out
  if out="$(aws cloudfront describe-function --name "$1" --stage LIVE \
    --query FunctionSummary.FunctionMetadata.FunctionARN --output text 2>"$TMP/err")"; then
    echo "$out"
  elif grep -q NoSuchFunctionExists "$TMP/err"; then
    echo ""
  else
    cat "$TMP/err" >&2
    return 1
  fi
}

SITE_BUCKET="$(ssm site-bucket)"
ART_BUCKET="$(ssm artifact-bucket)"
PATH_DIST="$(ssm site-distribution-id)"
ART_DIST="$(ssm cdn-distribution-id)"
HOST_DIST="$(stack_resource SiteHostDistribution)"
if [ -z "$SITE_BUCKET" ] || [ -z "$ART_BUCKET" ] || [ -z "$PATH_DIST" ] || [ -z "$ART_DIST" ]; then
  echo "refusing: an SSM pointer (site-bucket, artifact-bucket, site-distribution-id, cdn-distribution-id) is empty on ${STAGE}" >&2
  exit 1
fi

label_of() { case "$1" in "$SITE_BUCKET") echo site ;; *) echo artifact ;; esac; }
dist_label() { case "$1" in "$PATH_DIST") echo path-host ;; "$HOST_DIST") echo site-host ;; *) echo artifact ;; esac; }
fronts_of() { if [ "$1" = "$SITE_BUCKET" ]; then echo "$PATH_DIST${HOST_DIST:+ $HOST_DIST}"; else echo "$ART_DIST"; fi; }
# ARNs are looked up here, in the main shell, so a failed lookup stops the
# script instead of turning into an empty SourceArn inside `$(...)`.
for d in "$PATH_DIST" "$ART_DIST" ${HOST_DIST:+"$HOST_DIST"}; do
  aws cloudfront get-distribution --id "$d" --query Distribution.ARN --output text >"$TMP/$d.arn"
  grep -Eq '^arn:aws:cloudfront::[0-9]{12}:distribution/[A-Z0-9]+$' "$TMP/$d.arn" ||
    { echo "refusing: could not read the ARN of the $(dist_label "$d") distribution" >&2; exit 1; }
done
arn_of() { cat "$TMP/$1.arn"; } # distribution → ARN (resolved above)
arns_json() { # bucket → JSON array of the ARNs that may read it, sorted
  local a=()
  for d in $(fronts_of "$1"); do a+=("$(arn_of "$d")"); done
  printf '%s\n' "${a[@]}" | jq -R . | jq -sc 'sort'
}
policy_of() { # bucket → $TMP/<bucket>.policy.json ({"Statement":[]} when it has none)
  if aws s3api get-bucket-policy --bucket "$1" --query Policy --output text \
    >"$TMP/$1.policy.json" 2>"$TMP/err"; then
    jq -e . "$TMP/$1.policy.json" >/dev/null
  elif grep -q NoSuchBucketPolicy "$TMP/err"; then
    echo '{"Version":"2012-10-17","Statement":[]}' >"$TMP/$1.policy.json"
  else
    cat "$TMP/err" >&2
    return 1
  fi
}
pab_of() { # bucket → its Block Public Access flags as JSON (all false when unset)
  local out
  if out="$(aws s3api get-public-access-block --bucket "$1" \
    --query PublicAccessBlockConfiguration --output json 2>"$TMP/err")"; then
    jq -c '{BlockPublicAcls: (.BlockPublicAcls // false), IgnorePublicAcls: (.IgnorePublicAcls // false), BlockPublicPolicy: (.BlockPublicPolicy // false), RestrictPublicBuckets: (.RestrictPublicBuckets // false)}' <<<"$out"
  elif grep -q NoSuchPublicAccessBlockConfiguration "$TMP/err"; then
    echo '{"BlockPublicAcls":false,"IgnorePublicAcls":false,"BlockPublicPolicy":false,"RestrictPublicBuckets":false}'
  else
    cat "$TMP/err" >&2
    return 1
  fi
}
has_website() { # bucket → true with website hosting, false without; other errors stop
  if aws s3api get-bucket-website --bucket "$1" >/dev/null 2>"$TMP/err"; then
    return 0
  elif grep -q NoSuchWebsiteConfiguration "$TMP/err"; then
    return 1
  fi
  cat "$TMP/err" >&2
  exit 1
}

# Statement shapes, as jq predicates over one statement.
ANON='((.Effect == "Allow") and ([.Principal | .. | strings] | any(. == "*")))'
# Any statement naming the CloudFront service, and the read-only kind.
CFP='(.Principal == {"Service": "cloudfront.amazonaws.com"})'
CF="((.Effect == \"Allow\") and $CFP and ([.Action] | flatten | all(. == \"s3:GetObject\")))"
SOURCES='([.Condition.StringEquals["AWS:SourceArn"]?] | flatten | map(select(. != null)) | sort)'
# An older CloudFront statement that says exactly what ours says, for some of
# our distributions (needs $b and $want): folded into ours. Any other
# CloudFront statement is refused rather than widened or dropped.
FOLD="($CF and (([.Resource] | flatten) == [\"arn:aws:s3:::\" + \$b + \"/*\"])
  and (((.Condition // {}) | keys) == [\"StringEquals\"])
  and (((.Condition.StringEquals // {}) | keys) == [\"AWS:SourceArn\"])
  and ($SOURCES | length) > 0 and (($SOURCES - \$want) | length) == 0)"
# S3 hands a one-element list back as a plain string: compare policies with
# every such field as a sorted list, and the statements in a fixed order, or
# each run rewrites an unchanged policy.
NORM='.Statement |= (map(
  (if .Condition.StringEquals["AWS:SourceArn"]? != null then .Condition.StringEquals["AWS:SourceArn"] |= ([.] | flatten | sort) else . end)
  | (if has("Resource") then .Resource |= ([.] | flatten | sort) else . end)
  | (if has("Action") then .Action |= ([.] | flatten | sort) else . end)) | sort_by(tojson))'

# check-deploy: only the per-site host and the site bucket matter.
if [ "$MODE" = check-deploy ]; then
  if [ -z "$HOST_DIST" ]; then
    echo "origin access: no per-site host in the stack yet; if this deploy creates one, run scripts/origin-oac.sh ${STAGE} apply --apply after it"
    exit 0
  fi
  policy_of "$SITE_BUCKET"
  if jq -e --arg a "$(arn_of "$HOST_DIST")" "any(.Statement[]; $CF and ($SOURCES | index(\$a) != null))" \
    "$TMP/$SITE_BUCKET.policy.json" >/dev/null; then
    echo "origin access: the site bucket lets the per-site host read"
    exit 0
  fi
  echo "refusing: the ${STAGE} site bucket does not let the per-site host read through origin access control — this deploy reads it that way and every {slug}.${G} would answer 403. Run scripts/origin-oac.sh ${STAGE} apply --apply first." >&2
  exit 1
fi

# Distribution state for one bucket: rest-oac | rest | website | other, plus function and headers.
dist_json() { # dist → $TMP/<dist>.dist.json (fresh)
  aws cloudfront get-distribution-config --id "$1" >"$TMP/$1.dist.json"
}
origin_kind() { # dist bucket → rest-oac | rest | website | none | several
  jq -r --arg b "$2" '
    [.DistributionConfig.Origins.Items[] | select(.DomainName | startswith($b + "."))] as $o
    | if ($o | length) == 0 then "none" elif ($o | length) > 1 then "several"
      else $o[0]
        | if (.DomainName | contains(".s3-website")) then "website"
          elif (.S3OriginConfig != null) and ((.OriginAccessControlId // "") != "") then "rest-oac"
          else "rest" end
      end' "$TMP/$1.dist.json"
}
origin_oac() { # dist bucket → the access control id of the bucket's origin
  jq -r --arg b "$2" '[.DistributionConfig.Origins.Items[] | select(.DomainName | startswith($b + ".")) | (.OriginAccessControlId // "")][0] // ""' "$TMP/$1.dist.json"
}
oac_signing() { # access control id → "<SigningBehavior> <type>" (cached)
  [ -s "$TMP/oac-$1" ] || aws cloudfront get-origin-access-control --id "$1" \
    --query 'OriginAccessControl.OriginAccessControlConfig.[SigningBehavior,OriginAccessControlOriginType]' \
    --output text | tr '\t' ' ' >"$TMP/oac-$1"
  cat "$TMP/oac-$1"
}
origin_state() { # dist bucket → origin_kind, with rest-oac only for an always-signing S3 control
  local k sig
  k="$(origin_kind "$1" "$2")"
  if [ "$k" = rest-oac ]; then
    sig="$(oac_signing "$(origin_oac "$1" "$2")")"
    [ "$sig" = "always s3" ] || k="rest-oac(signing ${sig})"
  fi
  echo "$k"
}
origin_headers() { # dist bucket → header names the origin sends, comma-separated
  jq -r --arg b "$2" '[.DistributionConfig.Origins.Items[] | select(.DomainName | startswith($b + ".")) | .CustomHeaders.Items[]? | .HeaderName] | join(",")' "$TMP/$1.dist.json"
}
viewer_fn() { # dist → the viewer-request function ARN of the default behaviour, "" if none
  jq -r '[.DistributionConfig.DefaultCacheBehavior.FunctionAssociations.Items[]? | select(.EventType == "viewer-request") | .FunctionARN][0] // ""' "$TMP/$1.dist.json"
}
dist_status() { aws cloudfront get-distribution --id "$1" --query Distribution.Status --output text; }

OAC_ID="$(stack_resource CdnOriginAccessControl)"
PATH_FN="$(function_arn "yyt-console-${STAGE}-path-host")"
ART_FN="$(function_arn "yyt-console-${STAGE}-artifact-cdn")"
fn_for() { if [ "$1" = "$PATH_DIST" ]; then echo "$PATH_FN"; else echo "$ART_FN"; fi; }
if SECRET_NAME="$(aws ssm get-parameter --region "$REGION" --name "/yyt-service/${STAGE}/origin-secret" \
  --query Parameter.Name --output text 2>"$TMP/err")"; then
  HAVE_SECRET=true
elif grep -q ParameterNotFound "$TMP/err"; then
  HAVE_SECRET=false
else
  cat "$TMP/err" >&2
  exit 1
fi

status() {
  echo "stage=${STAGE}: console stack control $([ -n "$OAC_ID" ] && echo present || echo missing), functions path-host $([ -n "$PATH_FN" ] && echo present || echo missing) / artifact-cdn $([ -n "$ART_FN" ] && echo present || echo missing); retired origin-secret $($HAVE_SECRET && echo "still in SSM" || echo gone)"
  for b in "$SITE_BUCKET" "$ART_BUCKET"; do
    policy_of "$b"
    echo "  $(label_of "$b") bucket: $(jq -r --argjson want "$(arns_json "$b")" "
      [.Statement[] | select($CF)] as \$cf
      | [.Statement[] | select($ANON)] as \$anon
      | \"CloudFront read \" + (if any(\$cf[]; .Sid == \"$SID\" and ($SOURCES == \$want)) then \"ok\"
          elif (\$cf | length) > 0 then \"partial (\" + ([\$cf[] | .Sid // \"no Sid\"] | join(\",\")) + \")\" else \"none\" end)
        + \", anonymous read \" + (if (\$anon | length) == 0 then \"none\"
          elif all(\$anon[]; .Condition != null) then \"conditioned\" else \"OPEN\" end)
        + (if any(.Statement[]; .Sid == \"YytQuarantine\") then \", quarantine present\" else \"\" end)" \
      "$TMP/$b.policy.json"); block public access $(pab_of "$b" | jq -r 'to_entries | map((.key | gsub("[a-z]"; "")) + "=" + (if .value then "on" else "off" end)) | join(" ")')"
    for d in $(fronts_of "$b"); do
      dist_json "$d"
      local fn h
      fn="$(viewer_fn "$d")"
      h="$(origin_headers "$d" "$b")"
      [ -n "$fn" ] && fn="${fn##*/}"
      echo "    $(dist_label "$d"): origin $(origin_state "$d" "$b"), function ${fn:-none}, origin headers ${h:-none}, $(dist_status "$d")"
    done
  done
}

if [ "$MODE" = status ]; then status; exit 0; fi

backup() { # name file → a unique 0600 copy under local/deploy/ (runs in `$(...)`: checks itself)
  mkdir -p "$BACKUP_DIR" || return 1
  local stamp out n=1
  stamp="${BACKUP_DIR}/${STAGE}-$1-$(date -u +%Y%m%dT%H%M%SZ)"
  out="${stamp}.json"
  while [ -e "$out" ]; do out="${stamp}-${n}.json"; n=$((n + 1)); done
  cp "$2" "$out" || return 1
  echo "local/deploy/$(basename "$out")"
}
# Shapes this script will not rewrite: say so rather than guess.
refuse_odd() { # bucket
  local odd dead
  odd="$(jq -r '[.Statement[] | select(has("NotPrincipal") or has("NotAction") or has("NotResource")) | (.Sid // "(no Sid)")] | join(", ")' "$TMP/$1.policy.json")"
  if [ -n "$odd" ]; then
    echo "refusing: statement(s) ${odd} of the $(label_of "$1") bucket use NotPrincipal/NotAction/NotResource; change them by hand" >&2
    exit 1
  fi
  dead="$(jq -r '[.Statement[] | select([.Principal | .. | strings] | any(test("^A(ROA|IDA)[0-9A-Z]{16,}$"))) | (.Sid // "(no Sid)")] | join(", ")' "$TMP/$1.policy.json")"
  if [ -n "$dead" ]; then
    echo "refusing: statement(s) ${dead} of the $(label_of "$1") bucket name deleted IAM principals; AWS rejects any rewrite of this policy until they are removed (rules/deployment.md → CDN emergency)" >&2
    exit 1
  fi
}
# Rewrite a bucket policy with a jq program; `keep` is a predicate for the
# statements the program must leave byte-for-byte alone.
write_policy() { # bucket jq-program keep-predicate what
  local b="$1" prog="$2" keep="$3" what="$4" args=()
  refuse_odd "$b"
  args=(--arg sid "$SID" --arg psid "$PUBLIC_SID" --arg b "$b" --argjson arns "$(arns_json "$b")")
  jq "${args[@]}" "$prog" "$TMP/$b.policy.json" >"$TMP/$b.new.json"
  if [ "$(jq -S "[.Statement[] | select($keep)]" "$TMP/$b.policy.json")" != \
    "$(jq -S "[.Statement[] | select($keep)]" "$TMP/$b.new.json")" ]; then
    echo "refusing: the rewrite would change statements it does not own" >&2
    exit 1
  fi
  if [ "$(jq -S "$NORM" "$TMP/$b.policy.json")" = "$(jq -S "$NORM" "$TMP/$b.new.json")" ]; then
    echo "[ok] $(label_of "$b") bucket: ${what} already"
    return
  fi
  if $DRY; then
    echo "[plan] $(label_of "$b") bucket: ${what}"
    return
  fi
  if [ "$(jq '.Statement | length' "$TMP/$b.new.json")" = 0 ]; then
    echo "refusing: the rewrite would leave the $(label_of "$b") bucket without statements" >&2
    exit 1
  fi
  local saved
  saved="$(backup "$(label_of "$b")-bucket-policy" "$TMP/$b.policy.json")" || exit 1
  aws s3api put-bucket-policy --bucket "$b" --policy "file://$TMP/$b.new.json"
  echo "[done] $(label_of "$b") bucket: ${what} (previous policy: ${saved})"
  policy_of "$b"
}
put_pab() { # bucket json what
  local cur
  cur="$(pab_of "$1")"
  if [ "$(jq -S . <<<"$cur")" = "$(jq -S . <<<"$2")" ]; then
    echo "[ok] $(label_of "$1") bucket: ${3} already"
    return
  fi
  if $DRY; then echo "[plan] $(label_of "$1") bucket: ${3}"; return; fi
  aws s3api put-public-access-block --bucket "$1" --public-access-block-configuration "$2"
  echo "[done] $(label_of "$1") bucket: ${3}"
}
update_dist() { # dist jq-program what [plan-note] → 0 when an update was submitted
  local d="$1" prog="$2" what="$3" note="${4:-}" etag saved
  # Called as an `if` condition, where `set -e` does not apply: every step
  # checks itself.
  dist_json "$d" || exit 1
  jq --arg b "$(bucket_of "$d")" --arg region "$REGION" --arg oac "$OAC_ID" --arg fn "$(fn_for "$d")" \
    "$prog" "$TMP/$d.dist.json" >"$TMP/$d.config.json" || exit 1
  if [ "$(jq -S .DistributionConfig "$TMP/$d.dist.json")" = "$(jq -S . "$TMP/$d.config.json")" ]; then
    echo "[ok] $(dist_label "$d"): ${what} already"
    return 1
  fi
  if $DRY; then echo "[plan] $(dist_label "$d"): ${what}${note:+ (now: ${note})}"; return 1; fi
  etag="$(jq -r .ETag "$TMP/$d.dist.json")"
  saved="$(backup "$(dist_label "$d")-distribution" "$TMP/$d.dist.json")" && [ -n "$saved" ] || exit 1
  aws cloudfront update-distribution --id "$d" --if-match "$etag" \
    --distribution-config "file://$TMP/$d.config.json" --query Distribution.Status --output text >/dev/null ||
    { echo "update of the $(dist_label "$d") distribution failed; nothing else was changed after it (run status, then again)" >&2; exit 1; }
  echo "[done] $(dist_label "$d"): ${what} (previous config: ${saved})"
  return 0
}
bucket_of() { if [ "$1" = "$ART_DIST" ]; then echo "$ART_BUCKET"; else echo "$SITE_BUCKET"; fi; }
wait_deployed() {
  [ "$#" -eq 0 ] && return
  echo "waiting for $# distribution(s) to deploy…"
  for d in "$@"; do aws cloudfront wait distribution-deployed --id "$d"; done
  echo "deployed $(date -u +%H:%M:%S) UTC"
}

# A distribution nobody here knows in front of a bucket would lose access.
refuse_unknown_fronts() {
  aws cloudfront list-distributions --output json >"$TMP/dists.json"
  for b in "$SITE_BUCKET" "$ART_BUCKET"; do
    for id in $(jq -r --arg b "$b" '.DistributionList.Items[]? | select(any(.Origins.Items[]; .DomainName | startswith($b + "."))) | .Id' "$TMP/dists.json"); do
      case " $(fronts_of "$b") " in
        *" $id "*) ;;
        *) echo "refusing: a distribution this script does not know reads the $(label_of "$b") bucket; it would answer 403" >&2; exit 1 ;;
      esac
    done
  done
}
refuse_unknown_fronts
# The console stack must not be mid-update: a rollback could not delete an
# access control or function a hand-made distribution has just started using,
# and the per-site host's origin may still change.
stack_status="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "yyt-console-${STAGE}" \
  --query 'Stacks[0].StackStatus' --output text)"
case "$stack_status" in
  *_IN_PROGRESS) echo "refusing: stack yyt-console-${STAGE} is ${stack_status}; run this when it settles" >&2; exit 1 ;;
esac

# Probes: HEAD requests; `bad` collects mismatches. A probe retries twice,
# 5 s apart: an edge may still hold what it read a moment before a write.
code() { curl -s -I -m 15 -o /dev/null -w '%{http_code}' "$@" || echo 000; }
bad=false
probe() { # label url want...
  local label="$1" url="$2" got="" ok=false w i
  shift 2
  for i in 1 2 3; do
    got="$(code "$url")"
    for w in "$@"; do [ "$got" = "$w" ] && ok=true; done
    $ok && break
    [ "$i" -lt 3 ] && sleep 5
  done
  if $ok; then
    echo "[probe] ${label}: ${got}"
  else
    echo "[probe] ${label}: ${got} (want $*)$([ "$got" = 000 ] && echo '; no answer: a disabled distribution?')"
    bad=true
  fi
}
held() { # bucket → JSON list of quarantined keys and prefixes (never probed)
  policy_of "$1"
  jq -c --arg p "arn:aws:s3:::$1/" '[.Statement[] | select(.Sid == "YytQuarantine") | .Resource] | flatten | map(ltrimstr($p) | rtrimstr("*"))' "$TMP/$1.policy.json"
}
probes() { # direct-want: 403 once closed, "any" before
  local direct="$1" miss site akey plus q
  miss="origin-oac-probe-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n').txt"
  q="$(held "$SITE_BUCKET")"
  site="$(aws s3api list-objects-v2 --bucket "$SITE_BUCKET" --query "Contents[?ends_with(Key, '/index.html')].Key" --output json |
    jq -r --argjson q "$q" '[(. // [])[] | select(test("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]/index.html$") and (test("--") | not))
      | select(. as $k | all($q[]; ($k | startswith(.)) | not)) | rtrimstr("/index.html")][0] // empty')"
  if [ -n "$site" ]; then
    probe "path host /${site}/" "https://${G}/${site}/" 200
    probe "path host /${site} (redirect)" "https://${G}/${site}" 302
    if [ -n "$HOST_DIST" ]; then probe "per-site host ${site}.${G}/" "https://${site}.${G}/" 200; fi
    if [ "$direct" = 403 ]; then
      probe "direct website read of ${site}/index.html" "http://${SITE_BUCKET}.s3-website.${REGION}.amazonaws.com/${site}/index.html" 403
      probe "direct REST read of ${site}/index.html" "https://${SITE_BUCKET}.s3.${REGION}.amazonaws.com/${site}/index.html" 403
    fi
  else
    echo "[probe] path host: no unquarantined {site}/index.html to read; skipped"
  fi
  probe "path host missing key" "https://${G}/${site:-x}/${miss}" 403 404
  q="$(held "$ART_BUCKET")"
  aws s3api list-objects-v2 --bucket "$ART_BUCKET" --max-items 1000 --query 'Contents[?Size > `0`].Key' --output json |
    jq -c --argjson q "$q" '[(. // [])[] | select(. as $k | all($q[]; ($k | startswith(.)) | not))]' >"$TMP/akeys.json"
  akey="$(jq -r '[.[] | select(test("^[A-Za-z0-9._/-]+$"))][0] // empty' "$TMP/akeys.json")"
  plus="$(jq -r '[.[] | select(test("^[A-Za-z0-9._/+-]+$") and contains("+"))][0] // empty' "$TMP/akeys.json")"
  if [ -n "$akey" ]; then
    probe "artifact CDN ${akey}" "https://${D}/${akey}" 200
    [ "$direct" = 403 ] && probe "direct REST read of that key" "https://${ART_BUCKET}.s3.${REGION}.amazonaws.com/${akey}" 403
  fi
  if [ -n "$plus" ]; then
    dist_json "$ART_DIST"
    if [ -n "$ART_FN" ] && [ "$(viewer_fn "$ART_DIST")" = "$ART_FN" ]; then
      probe "artifact CDN key with a literal +" "https://${D}/${plus}" 200
    else
      echo "[probe] artifact CDN key with a literal +: skipped (no function: S3 reads the + as a space until apply)"
    fi
  fi
  probe "artifact CDN missing key" "https://${D}/${miss}" 403 404
}

if [ "$MODE" = revert ]; then
  for d in "$PATH_DIST" "$ART_DIST"; do
    b="$(bucket_of "$d")"
    if ! has_website "$b"; then
      echo "[skip] $(dist_label "$d"): its bucket has no website hosting; it keeps reading through origin access control"
      continue
    fi
    policy_of "$b"
    want="$(pab_of "$b" | jq -c '.BlockPublicPolicy = false | .RestrictPublicBuckets = false')"
    put_pab "$b" "$want" "BlockPublicPolicy and RestrictPublicBuckets off (a public statement follows)"
    write_policy "$b" '
      if any(.Statement[]; .Sid == $psid) then .
      else .Statement += [{Sid: $psid, Effect: "Allow", Principal: "*", Action: "s3:GetObject", Resource: ("arn:aws:s3:::" + $b + "/*")}] end' \
      ".Sid != \"$PUBLIC_SID\"" "anonymous read added (${PUBLIC_SID})"
  done
  WAIT=()
  for d in "$PATH_DIST" "$ART_DIST"; do
    if ! has_website "$(bucket_of "$d")"; then
      # Still on origin access control; only the stack's function goes.
      if update_dist "$d" '
        .DistributionConfig
        | .DefaultCacheBehavior.FunctionAssociations = (
            [(.DefaultCacheBehavior.FunctionAssociations.Items // [])[] | select(.FunctionARN != $fn or $fn == "")]
            | {Quantity: length} + (if length > 0 then {Items: .} else {} end))' \
        "the console stack's function detached"; then WAIT+=("$d"); fi
      dist_json "$d"
      if [ -n "$OAC_ID" ] && [ "$(origin_oac "$d" "$(bucket_of "$d")")" = "$OAC_ID" ]; then
        echo "note: $(dist_label "$d") still reads through the console stack's access control; a console rollback cannot delete it"
      fi
      continue
    fi
    if update_dist "$d" '
      .DistributionConfig
      | .Origins.Items |= map(
          if (.DomainName | startswith($b + ".")) then
            .DomainName = ($b + ".s3-website." + $region + ".amazonaws.com")
            | del(.S3OriginConfig)
            | .OriginAccessControlId = ""
            | .CustomOriginConfig = {HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: "http-only",
                OriginSslProtocols: {Quantity: 1, Items: ["TLSv1.2"]}, OriginReadTimeout: 30, OriginKeepaliveTimeout: 5}
            | .CustomHeaders = {Quantity: 0}
          else . end)
      | .DefaultCacheBehavior.FunctionAssociations = (
          [(.DefaultCacheBehavior.FunctionAssociations.Items // [])[] | select(.FunctionARN != $fn or $fn == "")]
          | {Quantity: length} + (if length > 0 then {Items: .} else {} end))' \
      "public website origin, no function"; then WAIT+=("$d"); fi
  done
  if $DRY; then echo "(dry run; pass --apply)"; exit 0; fi
  wait_deployed ${WAIT[@]+"${WAIT[@]}"}
  probes any
  echo "note: a bucket with its anonymous read statement back is readable directly from S3, past the CDN guard and cdn-switch, until scripts/origin-oac.sh ${STAGE} apply --apply"
  if $bad; then echo "MISMATCH after revert: see the probes above" >&2; exit 1; fi
  exit 0
fi

# apply, step 1: every bucket lets its distributions read through a control.
for b in "$SITE_BUCKET" "$ART_BUCKET"; do
  policy_of "$b"
  foreign="$(jq -r --arg b "$b" --argjson want "$(arns_json "$b")" "
    [.Statement[] | select($CFP and .Sid != \"$SID\") | select($FOLD | not) | (.Sid // \"(no Sid)\")] | join(\", \")" \
    "$TMP/$b.policy.json")"
  if [ -n "$foreign" ]; then
    echo "refusing: CloudFront statement(s) ${foreign} of the $(label_of "$b") bucket say more than ${SID} would (another distribution, action, resource or condition); change them by hand" >&2
    exit 1
  fi
  write_policy "$b" "
    [.Statement[] | select(($CFP and .Sid != \$sid) | not) | select(.Sid != \$sid)] as \$rest
    | .Statement = \$rest + [{Sid: \$sid, Effect: \"Allow\", Principal: {Service: \"cloudfront.amazonaws.com\"},
        Action: \"s3:GetObject\", Resource: (\"arn:aws:s3:::\" + \$b + \"/*\"),
        Condition: {StringEquals: {\"AWS:SourceArn\": \$arns}}}]" \
    "($CFP or .Sid == \"$SID\") | not" "CloudFront read for $(jq -r 'length' <<<"$(arns_json "$b")") distribution(s) (${SID})"
done
# A dry run shows the plan against the current policy; the statement is only
# checked for real after a write.
if ! $DRY; then
  for b in "$SITE_BUCKET" "$ART_BUCKET"; do
    jq -e --argjson want "$(arns_json "$b")" "any(.Statement[]; .Sid == \"$SID\" and $CF and ($SOURCES == \$want))" \
      "$TMP/$b.policy.json" >/dev/null || { echo "the $(label_of "$b") bucket's ${SID} statement is not what was written" >&2; exit 1; }
  done
fi

# apply, step 2: the hand-made distributions read the REST endpoint through the control.
if [ -z "$OAC_ID" ] || [ -z "$PATH_FN" ] || [ -z "$ART_FN" ]; then
  echo "[wait] the console stack has no CdnOriginAccessControl or edge functions yet: scripts/deploy.sh console ${STAGE}, then run apply again"
  $DRY && echo "(dry run; pass --apply)"
  exit 0
fi
WAIT=()
for d in "$PATH_DIST" "$ART_DIST"; do
  dist_json "$d"
  b="$(bucket_of "$d")"
  kind="$(origin_kind "$d" "$b")"
  case "$kind" in none | several)
    echo "refusing: the $(dist_label "$d") distribution has ${kind} origin(s) for its bucket" >&2; exit 1 ;;
  esac
  if [ "$(jq -r --arg b "$b" '[.DistributionConfig.Origins.Items[] | select(.DomainName | startswith($b + ".")) | .Id][0] as $id | (.DistributionConfig.DefaultCacheBehavior.TargetOriginId == $id) and ((.DistributionConfig.CacheBehaviors.Quantity // 0) == 0)' "$TMP/$d.dist.json")" != true ]; then
    echo "refusing: the $(dist_label "$d") distribution has cache behaviours or a default origin this script does not expect" >&2
    exit 1
  fi
  fn="$(viewer_fn "$d")"
  if [ -n "$fn" ] && [ "$fn" != "$(fn_for "$d")" ]; then
    echo "refusing: the $(dist_label "$d") distribution runs another viewer-request function (${fn##*/})" >&2
    exit 1
  fi
  now="origin ${kind}, function $([ -n "$fn" ] && echo "${fn##*/}" || echo none), origin headers $(origin_headers "$d" "$b" | sed 's/^$/none/')"
  if update_dist "$d" '
    .DistributionConfig
    | .Origins.Items |= map(
        if (.DomainName | startswith($b + ".")) then
          .DomainName = ($b + ".s3." + $region + ".amazonaws.com")
          | del(.CustomOriginConfig)
          | .S3OriginConfig = ((.S3OriginConfig // {}) + {OriginAccessIdentity: ""})
          | .OriginAccessControlId = (if (.OriginAccessControlId // "") == "" then $oac else .OriginAccessControlId end)
          | .CustomHeaders = {Quantity: 0}
        else . end)
    | .DefaultCacheBehavior.FunctionAssociations = (
        [(.DefaultCacheBehavior.FunctionAssociations.Items // [])[] | select(.EventType != "viewer-request")]
        + [{FunctionARN: $fn, EventType: "viewer-request"}]
        | {Quantity: length, Items: .})' \
    "REST origin through origin access control, function $(basename "$(fn_for "$d")")" "$now"; then
    WAIT+=("$d")
  fi
done
if ! $DRY; then wait_deployed ${WAIT[@]+"${WAIT[@]}"}; fi

# apply, step 3: per bucket, once every distribution in front of it reads
# through a control, sends no origin header and is Deployed.
CLOSED=0
for b in "$SITE_BUCKET" "$ART_BUCKET"; do
  ready=true
  for d in $(fronts_of "$b"); do
    dist_json "$d"
    kind="$(origin_state "$d" "$b")"
    h="$(origin_headers "$d" "$b")"
    if [ "$kind" != rest-oac ] || [ -n "$h" ]; then
      ready=false
      if [ "$d" = "$HOST_DIST" ]; then
        echo "[wait] site-host does not read through origin access control yet (origin ${kind}, headers ${h:-none}): scripts/deploy.sh console ${STAGE}, then run apply again"
      else
        echo "[wait] $(dist_label "$d"): origin ${kind}, headers ${h:-none}"
      fi
    elif [ "$(dist_status "$d")" != Deployed ]; then
      ready=false
      echo "[wait] $(dist_label "$d") is still deploying"
    fi
  done
  if ! $ready; then
    $DRY && echo "[plan] close the $(label_of "$b") bucket once its distributions read through origin access control"
    continue
  fi
  policy_of "$b"
  write_policy "$b" "del(.Statement[] | select($ANON))" "($ANON) | not" "anonymous read removed"
  # BlockPublicAcls: never turned on for the prod artifact bucket, whose
  # legacy uploader (api.yyt.life/d) sends public-read; never turned off.
  want="$(pab_of "$b" | jq -c --argjson keep "$([ "$STAGE" = prod ] && [ "$b" = "$ART_BUCKET" ] && echo true || echo false)" \
    '.IgnorePublicAcls = true | .BlockPublicPolicy = true | .RestrictPublicBuckets = true | (if $keep then . else .BlockPublicAcls = true end)')"
  put_pab "$b" "$want" "block public access $(jq -r 'to_entries | map((.key | gsub("[a-z]"; "")) + "=" + (if .value then "on" else "off" end)) | join(" ")' <<<"$want")"
  CLOSED=$((CLOSED + 1))
done
# The retired origin secret goes once nothing sends or checks it.
if [ "$CLOSED" = 2 ] && $HAVE_SECRET; then
  if $DRY; then
    echo "[plan] delete the retired SSM /yyt-service/${STAGE}/origin-secret"
  else
    aws ssm delete-parameter --region "$REGION" --name "/yyt-service/${STAGE}/origin-secret"
    echo "[done] deleted the retired SSM /yyt-service/${STAGE}/origin-secret"
  fi
fi
if $DRY; then echo "(dry run; pass --apply)"; exit 0; fi

probes "$([ "$CLOSED" = 2 ] && echo 403 || echo any)"
if $bad; then
  echo "MISMATCH: something above is not what private origins give. Run scripts/origin-oac.sh ${STAGE} status and apply again first; if sites or assets keep answering 403 through CloudFront: scripts/origin-oac.sh ${STAGE} revert --apply (reopens direct reads until the next apply)" >&2
  exit 1
fi
