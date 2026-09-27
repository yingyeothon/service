#!/usr/bin/env bash
# Lock the public S3 origins behind CloudFront (docs/decisions.md *CDN cost
# guard and emergency stops* §11). The static-site buckets and the prod
# artifact bucket are public-read S3 website origins, so anyone who knows a
# bucket name can download straight from S3 — past the CDN guard, past
# `cdn-switch.sh`. This makes every CloudFront distribution in front of such a
# bucket send a secret `Referer` header, conditions every anonymous Allow of
# the bucket policy on it, and turns on the bucket's `IgnorePublicAcls` (an
# object ACL granting everyone read would otherwise still let a direct read
# through). CloudFront keeps working; a direct read is 403. Origin access
# control is not an option: S3 website endpoints do not support it, and the
# path host relies on the website endpoint's index documents and redirects.
#
# Usage: scripts/origin-lock.sh <dev|prod> <status|lock|unlock|check-deploy> [--apply] [--force]
#   status        each public bucket, its ACL setting and the distributions in front of it
#   lock          1. SSM /yyt-service/<stage>/origin-secret (SecureString; created if missing)
#                 2. the hand-made distributions in front of a public bucket send
#                    `Referer: <secret>` (update, then wait until Deployed); the
#                    per-site host is the console stack's — deploy console after 1
#                 3. per bucket, once every distribution in front of it sends the
#                    header: `IgnorePublicAcls`, then the Referer condition
#                 4. probe: an origin read through CloudFront works, a direct read is 403;
#                    a mismatch exits 1 and names the unlock command
#   unlock        removes the condition this secret wrote (emergency: 403s through
#                 CloudFront); `--force` removes any Referer condition (secret lost)
#   check-deploy  exit 1 when the site bucket is locked and SSM origin-secret is
#                 missing or different: a console deploy would drop or change the
#                 per-site host's header (`scripts/deploy.sh console` runs this)
# Rotation: unlock --apply → aws ssm delete-parameter → lock --apply (new secret)
# → scripts/deploy.sh console <stage> → lock --apply.
# Dry run unless --apply. Needs AWS_PROFILE=yyt, jq and curl. The secret is
# never printed or put on a command line (SSM, AWS configs, 0600 temp files);
# the policy backups this writes under local/deploy/ contain it (0600).
set -euo pipefail
umask 077

usage="usage: $0 <dev|prod> <status|lock|unlock|check-deploy> [--apply] [--force]"
STAGE="${1:?$usage}"
MODE="${2:?$usage}"
shift 2
DRY=true
FORCE=false
for a in "$@"; do
  case "$a" in
    --apply) DRY=false ;;
    --force) FORCE=true ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done
case "$STAGE" in dev | prod) ;; *) echo "$usage" >&2; exit 2 ;; esac
case "$MODE" in status | lock | unlock | check-deploy) ;; *) echo "$usage" >&2; exit 2 ;; esac
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
REGION=ap-northeast-2
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SECRET_NAME="/yyt-service/${STAGE}/origin-secret"
if [ "$STAGE" = prod ]; then D="d.yyt.life"; G="g.yyt.life"; else D="dev-d.yyt.life"; G="dev-g.yyt.life"; fi

ssm() {
  aws ssm get-parameter --region "$REGION" --name "/yyt-service/${STAGE}/$1" \
    --query Parameter.Value --output text
}
# A missing stack resource is "none"; any other error stops the script.
stack_resource() {
  local out
  if out="$(aws cloudformation describe-stack-resource --region "$REGION" \
    --stack-name "yyt-console-${STAGE}" --logical-resource-id "$1" \
    --query StackResourceDetail.PhysicalResourceId --output text 2>"$TMP/err")"; then
    echo "$out"
  elif grep -q "does not exist" "$TMP/err"; then
    echo ""
  else
    cat "$TMP/err" >&2
    return 1
  fi
}
# The secret, into a file only.
if aws ssm get-parameter --region "$REGION" --name "$SECRET_NAME" --with-decryption \
  --query Parameter.Value --output text >"$TMP/secret" 2>"$TMP/err"; then
  HAVE_SECRET=true
elif grep -q ParameterNotFound "$TMP/err"; then
  HAVE_SECRET=false
  : >"$TMP/secret"
else
  cat "$TMP/err" >&2
  exit 1
fi

SITE_BUCKET="$(ssm site-bucket)"
ART_BUCKET="$(ssm artifact-bucket)"
PATH_DIST="$(ssm site-distribution-id)"
ART_DIST="$(ssm cdn-distribution-id)"
HOST_DIST="$(stack_resource SiteHostDistribution)"
[ "$HOST_DIST" = "None" ] && HOST_DIST=""

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
# Every anonymous Allow is locked, whatever its action: a Referer condition only narrows it.
ANON='(.Effect == "Allow") and ([.Principal | .. | strings] | any(. == "*"))'
is_public() { jq -e "any(.Statement[]; $ANON)" "$TMP/$1.policy.json" >/dev/null; }
# Shapes this script will not rewrite: say so rather than guess.
refuse_odd() { # bucket
  local odd dead
  odd="$(jq -r "[.Statement[] | select(has(\"NotPrincipal\") or (($ANON) and has(\"NotAction\"))) | (.Sid // \"(no Sid)\")] | join(\", \")" "$TMP/$1.policy.json")"
  if [ -n "$odd" ]; then
    echo "refusing: statement(s) ${odd} of the $(label_of "$1") bucket use NotPrincipal/NotAction; lock them by hand" >&2
    exit 1
  fi
  dead="$(jq -r '[.Statement[] | select([.Principal | .. | strings] | any(test("^A(ROA|IDA)[0-9A-Z]{16,}$"))) | (.Sid // "(no Sid)")] | join(", ")' "$TMP/$1.policy.json")"
  if [ -n "$dead" ]; then
    echo "refusing: statement(s) ${dead} of the $(label_of "$1") bucket name deleted IAM principals; AWS rejects any rewrite of this policy until they are removed (rules/deployment.md → CDN emergency)" >&2
    exit 1
  fi
}
lock_state() { # bucket → open | locked | locked-other | partial
  jq -r --rawfile s "$TMP/secret" "
    [.Statement[] | select($ANON) | .Condition.StringEquals[\"aws:Referer\"]?] as \$r
    | (\$s | rtrimstr(\"\\n\")) as \$v
    | if (\$r | length) == 0 or all(\$r[]; . == null) then \"open\"
      elif \$v != \"\" and all(\$r[]; . == \$v) then \"locked\"
      elif all(\$r[]; . != null) then \"locked-other\"
      else \"partial\" end" "$TMP/$1.policy.json"
}
acls_ignored() { # bucket → true | false
  local out
  if out="$(aws s3api get-public-access-block --bucket "$1" \
    --query PublicAccessBlockConfiguration --output json 2>"$TMP/err")"; then
    jq -r '.IgnorePublicAcls == true' <<<"$out"
  elif grep -q NoSuchPublicAccessBlockConfiguration "$TMP/err"; then
    echo false
  else
    cat "$TMP/err" >&2
    return 1
  fi
}
# A distribution's origin(s) for a bucket (website or REST endpoint, not behind OAC).
origin_state() { # dist bucket → none | sends | missing | other
  aws cloudfront get-distribution-config --id "$1" >"$TMP/$1.dist.json"
  jq -r --arg b "$2" --rawfile s "$TMP/secret" '
    ($s | rtrimstr("\n")) as $v
    | [.DistributionConfig.Origins.Items[]
      | select(.DomainName | startswith($b + "."))
      | select((.OriginAccessControlId // "") == "")
      | [.CustomHeaders.Items[]? | select((.HeaderName | ascii_downcase) == "referer") | .HeaderValue]] as $o
    | if ($o | length) == 0 then "none"
      elif $v != "" and all($o[]; length == 1 and .[0] == $v) then "sends"
      elif all($o[]; length == 0) then "missing"
      else "other" end' "$TMP/$1.dist.json"
}
label_of() { case "$1" in "$SITE_BUCKET") echo site ;; *) echo artifact ;; esac; }
dist_label() { case "$1" in "$PATH_DIST") echo path-host ;; "$HOST_DIST") echo site-host ;; "$ART_DIST") echo artifact ;; *) echo "unknown distribution" ;; esac; }

# check-deploy: only the site bucket and the stack's own header matter.
if [ "$MODE" = check-deploy ]; then
  policy_of "$SITE_BUCKET"
  st="$(lock_state "$SITE_BUCKET")"
  if [ "$st" = open ]; then echo "origin lock: site bucket open; nothing to keep in step"; exit 0; fi
  if ! $HAVE_SECRET; then
    echo "refusing: the ${STAGE} site bucket is origin-locked but SSM ${SECRET_NAME} is missing — this deploy would drop the per-site host's Referer header and every {slug}.${G} would answer 403. Restore the parameter, or scripts/origin-lock.sh ${STAGE} unlock --apply --force first." >&2
    exit 1
  fi
  if [ "$st" != locked ]; then
    echo "refusing: the ${STAGE} site bucket's Referer condition does not match SSM ${SECRET_NAME} (${st}) — deploying would put a header the bucket rejects on the per-site host. Unlock first (scripts/origin-lock.sh ${STAGE} unlock --apply --force), deploy, then lock --apply." >&2
    exit 1
  fi
  echo "origin lock: site bucket locked with the current secret; the deploy keeps the header"
  exit 0
fi

# Which buckets are public, and which distributions front each (plain
# variables: no associative arrays, so bash 3.2 runs this too).
BUCKETS=()
fronts_of() { if [ "$1" = "$SITE_BUCKET" ]; then echo "$PATH_DIST ${HOST_DIST}"; else echo "$ART_DIST"; fi; }
host_of() { if [ "$1" = "$SITE_BUCKET" ]; then echo "$G"; else echo "$D"; fi; }
policy_of "$SITE_BUCKET"
if is_public "$SITE_BUCKET"; then BUCKETS+=("$SITE_BUCKET"); fi
policy_of "$ART_BUCKET"
if is_public "$ART_BUCKET"; then BUCKETS+=("$ART_BUCKET"); fi

echo "stage=${STAGE}: origin secret $($HAVE_SECRET && echo present || echo missing); public buckets: ${#BUCKETS[@]}"
for b in ${BUCKETS[@]+"${BUCKETS[@]}"}; do
  echo "  $(label_of "$b") bucket: anonymous read $(lock_state "$b"); public object ACLs $([ "$(acls_ignored "$b")" = true ] && echo ignored || echo honoured)"
  for d in $(fronts_of "$b"); do
    echo "    $(dist_label "$d"): $(origin_state "$d" "$b")"
  done
done
[ "$MODE" = status ] && exit 0

write_policy() { # bucket jq-program
  local b="$1" prog="$2" backup
  refuse_odd "$b"
  jq --rawfile s "$TMP/secret" "$prog" "$TMP/$b.policy.json" >"$TMP/$b.new.json"
  local others_old others_new
  others_old="$(jq -S "[.Statement[] | select(($ANON) | not)]" "$TMP/$b.policy.json")"
  others_new="$(jq -S "[.Statement[] | select(($ANON) | not)]" "$TMP/$b.new.json")"
  if [ "$others_old" != "$others_new" ]; then
    echo "refusing: the rewrite would change statements other than the anonymous Allows" >&2
    exit 1
  fi
  if $DRY; then
    echo "[plan] rewrite the $(label_of "$b") bucket's anonymous Allow statement(s) ($MODE)"
    return
  fi
  backup="$(cd "$(dirname "$0")/.." && pwd)/local/deploy/${STAGE}-$(label_of "$b")-bucket-policy-$(date -u +%Y%m%dT%H%M%SZ).json"
  mkdir -p "$(dirname "$backup")"
  cp "$TMP/$b.policy.json" "$backup"
  aws s3api put-bucket-policy --bucket "$b" --policy "file://$TMP/$b.new.json"
  echo "[done] $(label_of "$b") bucket policy written (previous one: local/deploy/$(basename "$backup"), contains the secret)"
  policy_of "$b"
}

if [ "$MODE" = unlock ]; then
  for b in ${BUCKETS[@]+"${BUCKETS[@]}"}; do
    st="$(lock_state "$b")"
    [ "$st" = open ] && { echo "[ok] $(label_of "$b") bucket already open"; continue; }
    if [ "$st" != locked ] && ! $FORCE; then
      echo "refusing: the $(label_of "$b") bucket's Referer condition is not this secret's (${st}); --force removes it anyway" >&2
      exit 1
    fi
    # Only the value this secret wrote, unless --force.
    write_policy "$b" "
      (\$s | rtrimstr(\"\\n\")) as \$v
      | .Statement |= map(if ($ANON) and (.Condition.StringEquals[\"aws:Referer\"]? != null)
          and ($FORCE or .Condition.StringEquals[\"aws:Referer\"] == \$v) then
        (.Condition.StringEquals |= del(.[\"aws:Referer\"]))
        | (if (.Condition.StringEquals // {}) == {} then del(.Condition.StringEquals) else . end)
        | (if (.Condition // {}) == {} then del(.Condition) else . end)
      else . end)"
  done
  $DRY && echo "(dry run; pass --apply)"
  echo "IgnorePublicAcls is left on: with the statement open again, reads work through it."
  exit 0
fi

# A Referer condition that is not this secret's (a deleted and recreated
# parameter, a hand edit) must be cleared first: rolling out a new value
# would put headers the bucket rejects on every distribution in front of it.
for b in ${BUCKETS[@]+"${BUCKETS[@]}"}; do
  st="$(lock_state "$b")"
  if [ "$st" = locked-other ] || [ "$st" = partial ] || { ! $HAVE_SECRET && [ "$st" != open ]; }; then
    echo "refusing: the $(label_of "$b") bucket carries a Referer condition that is not the current secret's (${st}); run unlock --apply --force first" >&2
    exit 1
  fi
done

# lock, step 1: the secret.
if ! $HAVE_SECRET; then
  if $DRY; then
    echo "[plan] create SecureString ${SECRET_NAME} (random, never printed); then deploy console ${STAGE}, then run lock again"
    echo "(dry run; pass --apply)"
    exit 0
  fi
  head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' >"$TMP/secret"
  aws ssm put-parameter --region "$REGION" --name "$SECRET_NAME" --type SecureString \
    --value "file://$TMP/secret" >/dev/null
  echo "[done] created ${SECRET_NAME}. Next: scripts/deploy.sh console ${STAGE} (the per-site host reads it), then run lock again."
  exit 0
fi

# No distribution this script does not know may front a bucket it locks:
# it would not send the header and would start answering 403.
aws cloudfront list-distributions --output json >"$TMP/dists.json"
for b in ${BUCKETS[@]+"${BUCKETS[@]}"}; do
  for id in $(jq -r --arg b "$b" '.DistributionList.Items[]? | select(any(.Origins.Items[]; .DomainName | startswith($b + "."))) | .Id' "$TMP/dists.json"); do
    case " $(fronts_of "$b") " in
      *" $id "*) ;;
      *) echo "refusing: a distribution this script does not know fronts the $(label_of "$b") bucket; it would answer 403 after the lock" >&2; exit 1 ;;
    esac
  done
done
# The stack must not be mid-update: its distribution's header could still change.
stack_status="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "yyt-console-${STAGE}" \
  --query 'Stacks[0].StackStatus' --output text)"
case "$stack_status" in
  *_IN_PROGRESS) echo "refusing: stack yyt-console-${STAGE} is ${stack_status}; run lock when it settles" >&2; exit 1 ;;
esac

# lock, step 2: hand-made distributions send the header.
WAIT=()
for b in ${BUCKETS[@]+"${BUCKETS[@]}"}; do
  for d in $(fronts_of "$b"); do
    [ "$d" = "$HOST_DIST" ] && continue # the stack's own: deploy console
    st="$(origin_state "$d" "$b")"
    case "$st" in
      sends | none) echo "[ok] $(dist_label "$d") header: $st" ;;
      *)
        if $DRY; then echo "[plan] $(dist_label "$d"): add the Referer origin header ($st now)"; continue; fi
        ETAG="$(jq -r .ETag "$TMP/$d.dist.json")"
        jq --arg b "$b" --rawfile s "$TMP/secret" '
          ($s | rtrimstr("\n")) as $v
          | .DistributionConfig
          | .Origins.Items |= map(
              if (.DomainName | startswith($b + ".")) and ((.OriginAccessControlId // "") == "") then
                .CustomHeaders = (
                  [(.CustomHeaders.Items // [])[] | select((.HeaderName | ascii_downcase) != "referer")]
                  + [{HeaderName: "Referer", HeaderValue: $v}]
                  | {Quantity: length, Items: .})
              else . end)' "$TMP/$d.dist.json" >"$TMP/$d.config.json"
        aws cloudfront update-distribution --id "$d" --if-match "$ETAG" \
          --distribution-config "file://$TMP/$d.config.json" --query Distribution.Status --output text >/dev/null
        echo "[done] $(dist_label "$d"): Referer origin header set"
        WAIT+=("$d")
        ;;
    esac
  done
done
if [ "${#WAIT[@]}" -gt 0 ]; then
  echo "waiting for ${#WAIT[@]} distribution(s) to deploy…"
  for d in ${WAIT[@]+"${WAIT[@]}"}; do aws cloudfront wait distribution-deployed --id "$d"; done
fi

# lock, step 3: per bucket, once every front sends the header and is Deployed.
LOCKED=()
for b in ${BUCKETS[@]+"${BUCKETS[@]}"}; do
  ready=true
  for d in $(fronts_of "$b"); do
    st="$(origin_state "$d" "$b")"
    if [ "$st" != sends ] && [ "$st" != none ]; then
      ready=false
      if [ "$d" = "$HOST_DIST" ]; then
        echo "[wait] site-host does not send the header yet: scripts/deploy.sh console ${STAGE}, then run lock again"
      elif ! $DRY; then
        echo "[wait] $(dist_label "$d") does not send the header yet" >&2
      fi
    fi
    [ "$(aws cloudfront get-distribution --id "$d" --query Distribution.Status --output text)" = Deployed ] || ready=false
  done
  st="$(lock_state "$b")"
  if [ "$st" = locked-other ] || [ "$st" = partial ]; then
    echo "refusing: the $(label_of "$b") bucket already has a Referer condition that is not this secret's (${st}); unlock --force first" >&2
    exit 1
  fi
  if ! $ready; then
    $DRY && echo "[plan] lock the $(label_of "$b") bucket once its distributions send the header" || echo "[skip] $(label_of "$b") bucket not locked"
    continue
  fi
  # Public object ACLs first: a conditioned policy does not override an ACL grant.
  if [ "$(acls_ignored "$b")" != true ]; then
    if $DRY; then
      echo "[plan] $(label_of "$b") bucket: IgnorePublicAcls on (BlockPublicPolicy and RestrictPublicBuckets stay off: the conditioned statement is still public)"
    else
      cur="$(aws s3api get-public-access-block --bucket "$b" --query PublicAccessBlockConfiguration --output json 2>/dev/null || echo '{}')"
      cfg="$(jq -c '{BlockPublicAcls: (.BlockPublicAcls // false), IgnorePublicAcls: true, BlockPublicPolicy: (.BlockPublicPolicy // false), RestrictPublicBuckets: (.RestrictPublicBuckets // false)}' <<<"$cur")"
      aws s3api put-public-access-block --bucket "$b" --public-access-block-configuration "$cfg"
      echo "[done] $(label_of "$b") bucket: IgnorePublicAcls on"
    fi
  fi
  if [ "$st" = locked ]; then
    echo "[ok] $(label_of "$b") bucket already locked"
  else
    write_policy "$b" "
      (\$s | rtrimstr(\"\\n\")) as \$v
      | .Statement |= map(if ($ANON) then .Condition.StringEquals[\"aws:Referer\"] = \$v else . end)"
  fi
  LOCKED+=("$b")
done
if $DRY; then echo "(dry run; pass --apply)"; exit 0; fi

# lock, step 4: probes — HEAD only, never fatal to the script's own flow, but a mismatch exits 1.
code() { curl -s -I -m 15 -o /dev/null -w '%{http_code}' "$@" || echo 000; }
bad=false
for b in ${LOCKED[@]+"${LOCKED[@]}"}; do
  host="$(host_of "$b")"
  # A key nobody has: never cached, so the answer is the origin's. 404 = the
  # website endpoint accepted CloudFront's header; 403 = it refused it.
  miss="origin-lock-probe-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n').txt"
  via="$(code "https://${host}/${miss}")"
  key="$(aws s3api list-objects-v2 --bucket "$b" --max-items 200 \
    --query 'Contents[?Size > `0`].Key' --output json |
    jq -r '[(. // [])[] | select(test("^[A-Za-z0-9._/-]+$") and (endswith("/") | not))][0] // empty')"
  direct_site="-" direct_rest="-"
  if [ -n "$key" ]; then
    direct_site="$(code "http://${b}.s3-website.${REGION}.amazonaws.com/${key}")"
    direct_rest="$(code "https://${b}.s3.${REGION}.amazonaws.com/${key}")"
  fi
  echo "[probe] $(label_of "$b"): origin read through ${host} ${via} (want 404), direct website ${direct_site}, direct REST ${direct_rest} (want 403)"
  { [ "$via" = 404 ] && [ "$direct_site" != 200 ] && [ "$direct_rest" != 200 ]; } || bad=true
  if [ "$b" = "$SITE_BUCKET" ] && [ -n "$HOST_DIST" ]; then
    lkey="$(aws s3api list-objects-v2 --bucket "$b" --max-items 400 --query 'Contents[?Size > `0`].Key' --output json |
      jq -r '[(. // [])[] | select(test("^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]/[A-Za-z0-9._/-]+$") and (test("--") | not))][0] // empty')"
    if [ -n "$lkey" ]; then
      h="$(curl -s -I -m 15 -o /dev/null -w '%{http_code}' "https://${lkey%%/*}.${host}/${lkey#*/}" || echo 000)"
      echo "[probe] site-host: an existing object answers ${h} (want 200; the header itself is checked above)"
      [ "$h" = 200 ] || bad=true
    fi
  fi
done
if $bad; then
  echo "MISMATCH: something above is not what a working lock gives. If sites answer 403 through CloudFront: scripts/origin-lock.sh ${STAGE} unlock --apply" >&2
  exit 1
fi
