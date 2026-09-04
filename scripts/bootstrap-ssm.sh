#!/bin/bash
# Uploads machine-local credentials to SSM so serverless.yml can resolve
# ${ssm:/yyt-service/<stage>/<service>/<key>}. Run once per stage (and again after rotation).
#
# Usage: scripts/bootstrap-ssm.sh <dev|prod> [service...]   (default: console auth topic match state)
# Input: local/env/<service>.<stage>.env (gitignored; layout in local/env.example).
# Keys per service: mysql-{host,port,database,user,password} redis-{host,port,user,password} redis-key-prefix.
#   `state` is the exception: it holds no Redis connection at all (a channel row carries secrets and
#   rules/data.md forbids caching one), so only the mysql-* keys are read for it.
# console only (optional): redis-acl-{user,password} — the account that mints per-channel
#   participant Redis credentials (todo/16 §B). Absent = those routes answer 503.
# Stage-wide keys (uploaded only when set): DEBUG_KEY (dev only; generated when absent), SESSION_SECRET,
#   and GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET/ADMIN_GITHUB_LOGINS — taken from the shell environment, else from
#   local/env/console.<stage>.env (console owns the operator OAuth app).
# Stage-wide, gateway (todo/14): gateway-token is generated when absent and kept across re-runs
#   (GATEWAY_TOKEN=... rotates it), and written to local/deploy/gateway-token.<stage>.
#   gateway-ws-url is NOT touched here — it is a public domain, set by hand as a plain String
#   parameter once the gateway resolves; while unset, lobby/q channel views omit `wsUrl`.
# Always: cloudfront-cert-arn (looked up from ACM us-east-1, used by services/console CloudFront).
# dev only: auth's debug seeding hook writes the console DB, so console.dev.env's MySQL account is also
#   published as /yyt-service/dev/auth/debug-mysql-{user,password} (docs/decisions.md "디버그 시드").
# Legacy /yyt-service/<stage>/upstash-* parameters are deleted.
# Logs (names only, never values) go to local/deploy/bootstrap-ssm.<stage>.log.
# state only (todo/33): kv-kek is the stage KEK that wraps every kv collection's data key.
#   Taken from KV_KEK or local/env/state.<stage>.env, generated when neither SSM nor the env
#   file has one, and otherwise kept — replacing it needs KV_KEK_ROTATE=1 and makes every
#   stored kv value unreadable, so it is excluded from the blanket rotation below.
# Rotation: update local/env via yyt-stateful → run this → redeploy EVERY stack of the stage
#   (values are baked into Lambda env at deploy time) → only then revoke the old credentials.
#   kv-kek is NOT part of that pass: see above.
set -euo pipefail
umask 077 # everything this script writes (logs, debug key, temp files) is owner-only
STAGE="${1:?stage (dev|prod)}"; shift || true
SERVICES=("$@"); [ ${#SERVICES[@]} -eq 0 ] && SERVICES=(console auth topic match state)
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
cd "$(dirname "$0")/.."
mkdir -p local/deploy
LOG="local/deploy/bootstrap-ssm.${STAGE}.log"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }

TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
put() { # name value — the value goes through a 0600 temp file, never argv (visible in `ps`).
  if [ -z "$2" ]; then log "skip /yyt-service/${STAGE}/$1 (empty)"; return 0; fi
  printf '%s' "$2" > "$TMP"
  aws ssm put-parameter --name "/yyt-service/${STAGE}/$1" --type SecureString --value "file://${TMP}" --overwrite >/dev/null
  log "put /yyt-service/${STAGE}/$1"
}
envval() { # file VAR — plain KEY=value parse; the file is never sourced as shell.
  grep -E "^${2}=" "$1" | head -n1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'
}

for svc in "${SERVICES[@]}"; do
  f="local/env/${svc}.${STAGE}.env"
  # A stage without a state stack is a valid state — its MySQL account may not
  # exist yet — so `state` is skipped rather than fatal. Every other service is
  # load-bearing on every stage.
  if [ ! -f "$f" ] && [ "$svc" = state ]; then log "skip state (no $f on this stage)"; continue; fi
  [ -f "$f" ] || { echo "missing $f (see local/README.md)" >&2; exit 1; }
  [ "$(envval "$f" STAGE)" = "$STAGE" ] || { echo "$f: STAGE mismatch" >&2; exit 1; }
  pairs=(mysql-host:MYSQL_HOST mysql-port:MYSQL_PORT mysql-database:MYSQL_DATABASE
         mysql-user:MYSQL_USER mysql-password:MYSQL_PASSWORD)
  # Every stack but `state` also holds a Redis connection.
  [ "$svc" = state ] || pairs+=(redis-host:REDIS_HOST redis-port:REDIS_PORT redis-user:REDIS_USER
                                redis-password:REDIS_PASSWORD redis-key-prefix:REDIS_KEY_PREFIX)
  for pair in "${pairs[@]}"; do
    key="${pair%%:*}"; var="${pair##*:}"
    v="$(envval "$f" "$var")"
    [ -n "$v" ] || { echo "$f: $var is empty" >&2; exit 1; }
    put "${svc}/${key}" "$v"
  done
done

if [ "${STAGE}" = "dev" ]; then
  # Keep the existing key across re-runs (e.g. a MySQL rotation) so deployed
  # stacks and local/deploy/debug-key.dev stay valid; DEBUG_KEY=... forces a new one.
  if [ -z "${DEBUG_KEY:-}" ]; then
    DEBUG_KEY="$(aws ssm get-parameter --name "/yyt-service/dev/debug-key" --with-decryption --query Parameter.Value --output text 2>/dev/null || true)"
  fi
  DEBUG_KEY="${DEBUG_KEY:-$(openssl rand -hex 24)}"
  put debug-key "${DEBUG_KEY}"
  printf '%s\n' "${DEBUG_KEY}" > local/deploy/debug-key.dev
  chmod 600 local/deploy/debug-key.dev "$LOG" # umask does not fix pre-existing files
  log "debug-key written to local/deploy/debug-key.dev (for scripts/smoke/auth.mjs)"
  [ -f local/env/console.dev.env ] || { echo "missing local/env/console.dev.env (needed for auth debug seeding)" >&2; exit 1; }
  for var in MYSQL_USER MYSQL_PASSWORD; do
    v="$(envval local/env/console.dev.env "$var")"
    [ -n "$v" ] || { echo "console.dev.env: $var is empty" >&2; exit 1; }
    # `MYSQL_USER` → `user`, i.e. `auth/debug-mysql-user`, which is the key
    # services/auth/serverless.yml reads. Without stripping the prefix this
    # wrote `debug-mysql-mysql-user`: a parameter nothing resolves, so a
    # rotation of console's dev account would have left auth's debug seeding
    # pointing at the old password with no error anywhere.
    put "auth/debug-mysql-$(echo "${var#MYSQL_}" | tr 'A-Z_' 'a-z-')" "$v"
  done
fi
CONSOLE_ENV="local/env/console.${STAGE}.env"
# Console-only: the Redis account that mints per-channel participant credentials
# (todo/16 §B). Optional — while unset, /channels/{id}/redis-user answers 503 and
# nothing else changes. Created on the host by yyt-stateful, never by this repo.
if [ -f "$CONSOLE_ENV" ]; then
  acl_user="$(envval "$CONSOLE_ENV" REDIS_ACL_USER)"
  acl_pw="$(envval "$CONSOLE_ENV" REDIS_ACL_PASSWORD)"
  # Both or neither. `put` skips an empty value silently, so a half-set pair
  # would upload the username, leave the password absent, and produce a stage
  # where every credential route 503s while SSM visibly holds a user name.
  if { [ -n "$acl_user" ] && [ -z "$acl_pw" ]; } || { [ -z "$acl_user" ] && [ -n "$acl_pw" ]; }; then
    echo "$CONSOLE_ENV: set both REDIS_ACL_USER and REDIS_ACL_PASSWORD, or neither" >&2; exit 1
  fi
  put console/redis-acl-user "$acl_user"
  put console/redis-acl-password "$acl_pw"
  # Removing the issuer needs an explicit delete: `put` never deletes, so
  # clearing the env file alone would leave the stale pair in SSM and the next
  # deploy would bake a revoked credential back into the Lambda.
  if [ -z "$acl_user" ]; then
    for k in redis-acl-user redis-acl-password; do
      if aws ssm delete-parameter --name "/yyt-service/${STAGE}/console/${k}" >/dev/null 2>&1; then
        log "deleted /yyt-service/${STAGE}/console/${k} (issuer unset locally)"
      fi
    done
  fi
fi
for var in GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET ADMIN_GITHUB_LOGINS; do
  if [ -z "${!var:-}" ] && [ -f "$CONSOLE_ENV" ]; then
    declare "$var=$(envval "$CONSOLE_ENV" "$var")"
  fi
done
if [ "${STAGE}" = "prod" ] && [ -z "${ADMIN_GITHUB_LOGINS:-}" ] && ! aws ssm get-parameter --name "/yyt-service/prod/admin-github-logins" >/dev/null 2>&1; then
  echo "prod needs ADMIN_GITHUB_LOGINS (otherwise nobody can approve console members)" >&2; exit 1
fi
put github-client-id "${GITHUB_CLIENT_ID:-}"
put github-client-secret "${GITHUB_CLIENT_SECRET:-}"
put admin-github-logins "${ADMIN_GITHUB_LOGINS:-}"
put session-secret "${SESSION_SECRET:-}"

# Realtime gateway (todo/14): the console checks GATEWAY_TOKEN on
# GET /gw/channels/{id}. Generated once per stage and kept across re-runs, the
# same way as debug-key; GATEWAY_TOKEN=... forces a new one (then redeploy
# console AND the gateway). It must be >= 32 chars — the console disables the
# route and logs an error below that, so generate rather than hand-pick.
if [ -z "${GATEWAY_TOKEN:-}" ]; then
  GATEWAY_TOKEN="$(aws ssm get-parameter --name "/yyt-service/${STAGE}/gateway-token" --with-decryption --query Parameter.Value --output text 2>/dev/null || true)"
fi
GATEWAY_TOKEN="${GATEWAY_TOKEN:-gw_$(openssl rand -hex 32)}"
if [ "${#GATEWAY_TOKEN}" -lt 32 ]; then
  echo "GATEWAY_TOKEN must be at least 32 characters (console refuses shorter ones)" >&2; exit 1
fi
put gateway-token "${GATEWAY_TOKEN}"
printf '%s\n' "${GATEWAY_TOKEN}" > "local/deploy/gateway-token.${STAGE}"
chmod 600 "local/deploy/gateway-token.${STAGE}"
log "gateway-token written to local/deploy/gateway-token.${STAGE} (hand it to the gateway; scripts/smoke/console.mjs reads it)"
# artifact-bucket / site-bucket (the hand-made distribution and static-site
# buckets, plain Strings) are set by hand once per stage — bucket names are
# infra identifiers (docs/secrets.md), so serverless.yml reads them from SSM:
#   aws ssm put-parameter --name /yyt-service/<stage>/site-bucket --type String --value <bucket>
# GATEWAY_WS_URL is a public domain, not a secret, and is set by hand once the
# gateway actually resolves:
#   aws ssm put-parameter --name /yyt-service/<stage>/gateway-ws-url --type String --value wss://gw…
# Until then it stays unset and lobby/q views omit `wsUrl` entirely.

# The state service's public base URL, so console can show `docUrl` on an auth
# channel. Not a secret, hence a plain String — and written only when this stage
# actually has a state stack (its env file is the signal). Absent, console omits
# `docUrl` entirely rather than printing a host that does not resolve, the same
# discipline `gateway-ws-url` follows above.
# Only when `state` was actually named (or defaulted) for this run. The signal
# is a file on the operator's machine, and this block sits outside the
# per-service loop, so without the guard `bootstrap-ssm.sh dev console` after a
# password rotation would delete a stage-wide parameter for a service it was
# never asked about — and the next console deploy would quietly stop
# advertising `docUrl` for a reason unrelated to anything the operator did.
DOC_DOMAIN="doc.yyt.life"; [ "$STAGE" = prod ] || DOC_DOMAIN="doc-dev.yyt.life"
case " ${SERVICES[*]} " in *" state "*) DOC_TOUCH=1 ;; *) DOC_TOUCH=0 ;; esac
if [ "$DOC_TOUCH" = 0 ]; then
  log "skip /yyt-service/${STAGE}/doc-base-url (state not in this run)"
elif [ -f "local/env/state.${STAGE}.env" ]; then
  aws ssm put-parameter --name "/yyt-service/${STAGE}/doc-base-url" --type String \
    --value "https://${DOC_DOMAIN}" --overwrite >/dev/null
  log "put /yyt-service/${STAGE}/doc-base-url"
else
  # `put` never deletes, so clearing the env file alone would leave console
  # advertising an endpoint this stage no longer serves. A missing parameter is
  # the expected case; anything else (AccessDenied) must be visible, not
  # swallowed into a stage that keeps advertising a decommissioned endpoint.
  err="$(aws ssm delete-parameter --name "/yyt-service/${STAGE}/doc-base-url" 2>&1 >/dev/null)" && \
    log "deleted /yyt-service/${STAGE}/doc-base-url (no state stack on this stage)" || \
    case "$err" in
      *ParameterNotFound*) : ;;
      *) echo "failed to delete /yyt-service/${STAGE}/doc-base-url: $err" >&2; exit 1 ;;
    esac
fi

# The stage KEK that wraps every kv collection's data key (docs/decisions.md
# *Key-value store* #8). Kept across re-runs like debug-key and gateway-token, with
# one guard neither of those needs: a *new* KEK makes every stored value unreadable
# for good, so a read that fails for any reason other than "not there yet" stops the
# script instead of minting a replacement over a parameter that is merely unreachable.
KEK_NAME="state/kv-kek"
case " ${SERVICES[*]} " in *" state "*) KEK_TOUCH=1 ;; *) KEK_TOUCH=0 ;; esac
if [ "$KEK_TOUCH" = 0 ]; then
  # The two skips are different situations and get different words: one is
  # "you did not ask for state", the other is "this machine has no state env
  # file" — which for a stage that *does* run kv is a get-env.sh step the
  # operator still owes, not a no-op they chose.
  log "skip /yyt-service/${STAGE}/${KEK_NAME} (state not in this run)"
elif [ ! -f "local/env/state.${STAGE}.env" ]; then
  log "skip /yyt-service/${STAGE}/${KEK_NAME} (no local/env/state.${STAGE}.env on this machine)"
else
  # One call, both streams, kept apart. Folded together with a plain `2>&1`,
  # any line the CLI writes to stderr on a *successful* call (a botocore
  # deprecation warning, an SSO refresh notice) would become part of
  # `CURRENT_KEK`, and the script would then report "already holds a different
  # KEK" and recommend KV_KEK_ROTATE=1 — the one destructive answer — for a
  # stage whose KEK is fine. Asking twice instead (once for the value, once for
  # the error) is worse still: a read that fails and then succeeds leaves no
  # error to classify and exits with an empty reason.
  KEK_ERR="$(mktemp)"
  if kek_read="$(aws ssm get-parameter --name "/yyt-service/${STAGE}/${KEK_NAME}" --with-decryption --query Parameter.Value --output text 2>"$KEK_ERR")"; then
    CURRENT_KEK="$kek_read"
  else
    case "$(cat "$KEK_ERR")" in
      *ParameterNotFound*) CURRENT_KEK="" ;;
      *) echo "failed to read /yyt-service/${STAGE}/${KEK_NAME}: $(cat "$KEK_ERR")" >&2; rm -f "$KEK_ERR"; exit 1 ;;
    esac
  fi
  rm -f "$KEK_ERR"
  # `|| true` because this is the one optional key `envval` is asked for: under
  # `pipefail` its leading `grep` returns 1 when the line is absent, which takes
  # the whole script down with `set -e` before any of the logic below runs.
  WANT_KEK="${KV_KEK:-$(envval "local/env/state.${STAGE}.env" KV_KEK || true)}"
  # The state stack validates the same shape at cold start and 503s the kv routes
  # below it; catching it here is the difference between a typo and a dead stage.
  is_kek() { printf '%s' "$1" | grep -qE '^[0-9a-fA-F]{64}$'; }
  if [ -n "$WANT_KEK" ] && ! is_kek "$WANT_KEK"; then
    echo "KV_KEK must be 32 bytes of hex (64 hex characters)" >&2; exit 1
  fi
  if [ -z "$WANT_KEK" ] || [ "$WANT_KEK" = "$CURRENT_KEK" ]; then
    KEK="$CURRENT_KEK"
  elif [ -z "$CURRENT_KEK" ]; then
    KEK="$WANT_KEK"
  elif [ "${KV_KEK_ROTATE:-0}" = "1" ]; then
    KEK="$WANT_KEK"
    log "WARN rotating ${KEK_NAME}: every value wrapped with the old KEK becomes unreadable"
  else
    echo "/yyt-service/${STAGE}/${KEK_NAME} already holds a different KEK; set KV_KEK_ROTATE=1 to replace it (every stored kv value becomes unreadable)" >&2
    exit 1
  fi
  if [ -z "$KEK" ]; then
    KEK="$(openssl rand -hex 32)"
    log "generated a new ${KEK_NAME} — pull it with FORCE=1 scripts/get-env.sh ${STAGE} state (it refuses to overwrite an existing env file) and copy it into the ops repo"
  fi
  # A value that was already in SSM has never been through the check above, so
  # a KEK put there by hand can leave every /kv/* route answering 503 while this
  # script cheerfully reports the stage unchanged. Not fatal — refusing would
  # only block the operator from fixing anything else — but never silent.
  is_kek "$KEK" || log "WARN /yyt-service/${STAGE}/${KEK_NAME} is not 32 bytes of hex; /kv/* will answer 503 until it is replaced (KV_KEK=… KV_KEK_ROTATE=1)"
  if [ "$KEK" = "$CURRENT_KEK" ]; then
    log "keep /yyt-service/${STAGE}/${KEK_NAME} (unchanged)"
  else
    # Which stage a supplied KEK was meant for is the operator's to know: the
    # env file is stage-scoped, an exported KV_KEK is not, and seeding a second
    # stage from the same shell would otherwise put one stage's KEK on another
    # with nothing in the log to say so.
    [ -z "${KV_KEK:-}" ] || log "using the KEK from the shell environment, not local/env/state.${STAGE}.env"
    put "$KEK_NAME" "$KEK"
  fi
fi

# CloudFront (console SPA) needs the us-east-1 certificate covering *.yyt.life;
# serverless.yml reads its ARN from SSM so no account-specific ARN lives in git.
CERT_ARN="$(aws acm list-certificates --region us-east-1 --certificate-statuses ISSUED \
  --query "CertificateSummaryList[?contains(SubjectAlternativeNameSummaries, '*.yyt.life')].CertificateArn | [0]" --output text)"
if [ -n "$CERT_ARN" ] && [ "$CERT_ARN" != "None" ]; then
  put cloudfront-cert-arn "$CERT_ARN"
else
  log "WARN no ISSUED us-east-1 ACM certificate for *.yyt.life; console deploy needs cloudfront-cert-arn (todo/07-infra.md)"
fi

for legacy in upstash-url upstash-token; do
  if aws ssm delete-parameter --name "/yyt-service/${STAGE}/${legacy}" >/dev/null 2>&1; then
    log "deleted legacy /yyt-service/${STAGE}/${legacy}"
  fi
done
log "done stage=${STAGE} services=${SERVICES[*]}"
