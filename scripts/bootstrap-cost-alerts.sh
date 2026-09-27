#!/usr/bin/env bash
# Account-level cost alerts (docs/decisions.md *CDN cost guard and emergency
# stops* §9). All free, none in any stack:
#   - Cost Anomaly Detection: the AWS-services monitor (reused if the account
#     already has one) and a daily e-mail subscription `yyt-daily` for
#     anomalies with at least $3 of impact.
#   - Budget `yyt-cloudfront`: CloudFront only, $5/month; e-mail at 20 % and
#     100 % actual and 100 % forecast.
#   - Budget `yyt-account`: $60/month; e-mail at 100 % actual and forecast. It
#     replaces `yyt-30usd`, which the yearly ~$40 domain renewal used up.
#   - The us-east-1 CloudWatch alarm `BillingAlarm` is deleted: it was an 11th
#     alarm against the 10-alarm free tier (rules/serverless-aws.md), and the
#     account budget does its job for free.
#
# Usage: scripts/bootstrap-cost-alerts.sh <email> [--apply]
# Dry run unless --apply; idempotent. The e-mail is only passed to AWS and
# printed masked — never written to a file in this repository. Each `aws ce`
# call is a billed Cost Explorer request ($0.01); a run makes two to four.
set -euo pipefail

usage="usage: $0 <email> [--apply]"
EMAIL="${1:?$usage}"
APPLY="${2:-}"
if [ -n "$APPLY" ] && [ "$APPLY" != "--apply" ]; then echo "$usage" >&2; exit 2; fi
if ! [[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]]; then
  echo "not an e-mail address" >&2
  exit 2
fi
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
# Budgets, Cost Explorer and billing alarms are served from us-east-1; passed
# per command, never exported (rules/deployment.md on AWS_DEFAULT_REGION).
R=(--region us-east-1)
MASKED="${EMAIL:0:1}***@${EMAIL#*@}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
DRY=true
[ "$APPLY" = "--apply" ] && DRY=false
plan() { echo "[plan] $*"; }
done_() { echo "[done] $*"; }

# Runs an aws call and prints "missing" instead of failing when AWS answers
# NotFoundException; any other error stops the script.
maybe() {
  local out
  if out="$("$@" 2>&1)"; then printf '%s' "$out"; return 0; fi
  if grep -q "NotFoundException" <<<"$out"; then printf 'missing'; return 0; fi
  echo "$out" >&2
  return 1
}

echo "account …${ACCOUNT: -4}, alerts to ${MASKED}$($DRY && echo ' (dry run)')"

# 1. Anomaly monitor: one AWS-services monitor per account; reuse it.
MON="$(aws ce get-anomaly-monitors "${R[@]}" --output json |
  jq -r '[.AnomalyMonitors[] | select(.MonitorType == "DIMENSIONAL" and .MonitorDimension == "SERVICE")][0].MonitorArn // ""')"
if [ -n "$MON" ]; then
  echo "[ok] anomaly monitor (AWS services) exists"
elif $DRY; then
  plan "create anomaly monitor yyt-services (DIMENSIONAL/SERVICE)"
else
  MON="$(aws ce create-anomaly-monitor "${R[@]}" \
    --anomaly-monitor '{"MonitorName":"yyt-services","MonitorType":"DIMENSIONAL","MonitorDimension":"SERVICE"}' \
    --query MonitorArn --output text)"
  done_ "anomaly monitor yyt-services created"
fi

# 2. Daily subscription.
THRESHOLD='{"Dimensions":{"Key":"ANOMALY_TOTAL_IMPACT_ABSOLUTE","MatchOptions":["GREATER_THAN_OR_EQUAL"],"Values":["3"]}}'
SUBSCRIBERS="$(jq -cn --arg e "$EMAIL" '[{Type: "EMAIL", Address: $e}]')"
SUB=""
if [ -n "$MON" ]; then
  SUB="$(aws ce get-anomaly-subscriptions "${R[@]}" --monitor-arn "$MON" --output json |
    jq -c '[.AnomalySubscriptions[] | select(.SubscriptionName == "yyt-daily")][0] // empty')"
fi
if [ -z "$SUB" ]; then
  if $DRY; then
    plan "create anomaly subscription yyt-daily: DAILY e-mail to ${MASKED}, impact >= \$3"
  else
    aws ce create-anomaly-subscription "${R[@]}" --anomaly-subscription "$(jq -cn \
      --arg mon "$MON" --argjson subs "$SUBSCRIBERS" --argjson th "$THRESHOLD" \
      '{SubscriptionName: "yyt-daily", MonitorArnList: [$mon], Subscribers: $subs, Frequency: "DAILY", ThresholdExpression: $th}')" \
      --query SubscriptionArn --output text >/dev/null
    done_ "anomaly subscription yyt-daily created"
  fi
elif jq -e --arg e "$EMAIL" --argjson th "$THRESHOLD" \
  '.Frequency == "DAILY" and ((.ThresholdExpression | if type == "string" then fromjson else . end) == $th) and any(.Subscribers[]; .Address == $e)' \
  <<<"$SUB" >/dev/null; then
  echo "[ok] anomaly subscription yyt-daily is as wanted"
elif $DRY; then
  plan "update anomaly subscription yyt-daily to DAILY, ${MASKED}, impact >= \$3"
else
  aws ce update-anomaly-subscription "${R[@]}" \
    --subscription-arn "$(jq -r .SubscriptionArn <<<"$SUB")" \
    --frequency DAILY --threshold-expression "$THRESHOLD" --subscribers "$SUBSCRIBERS" >/dev/null
  done_ "anomaly subscription yyt-daily updated"
fi

# 3. Budgets. $1 = name, $2 = USD limit, $3 = cost filters JSON, $4 = notifications JSON
# ([{type, percent}]). Creates it, or fixes the limit/filters and adds any
# missing notification; extra notifications are reported, never deleted.
budget() {
  local name="$1" usd="$2" filters="$3" wanted="$4" cur
  cur="$(maybe aws budgets describe-budget "${R[@]}" --account-id "$ACCOUNT" --budget-name "$name" --output json)"
  local spec
  spec="$(jq -cn --arg n "$name" --arg usd "$usd" --argjson f "$filters" \
    '{BudgetName: $n, BudgetType: "COST", TimeUnit: "MONTHLY", BudgetLimit: {Amount: $usd, Unit: "USD"}, CostFilters: $f}')"
  if [ "$cur" = missing ]; then
    if $DRY; then
      plan "create budget ${name}: \$${usd}/month, filters ${filters}, notifications ${wanted} to ${MASKED}"
      return 0
    fi
    aws budgets create-budget "${R[@]}" --account-id "$ACCOUNT" --budget "$spec" \
      --notifications-with-subscribers "$(jq -cn --arg e "$EMAIL" --argjson w "$wanted" \
        '[$w[] | {Notification: {NotificationType: .type, ComparisonOperator: "GREATER_THAN", Threshold: .percent, ThresholdType: "PERCENTAGE"}, Subscribers: [{SubscriptionType: "EMAIL", Address: $e}]}]')"
    done_ "budget ${name} created"
    return 0
  fi
  if jq -e --arg usd "$usd" --argjson f "$filters" \
    '(.Budget.BudgetLimit.Amount | tonumber) == ($usd | tonumber) and ((.Budget.CostFilters // {}) == $f)' \
    <<<"$cur" >/dev/null; then
    echo "[ok] budget ${name}: limit and filters as wanted"
  elif $DRY; then
    plan "update budget ${name} to \$${usd}/month, filters ${filters}"
  else
    aws budgets update-budget "${R[@]}" --account-id "$ACCOUNT" --new-budget "$spec"
    done_ "budget ${name} updated"
  fi
  local have
  have="$(aws budgets describe-notifications-for-budget "${R[@]}" --account-id "$ACCOUNT" \
    --budget-name "$name" --output json | jq -c '[.Notifications[] | {type: .NotificationType, percent: .Threshold}]')"
  jq -c --argjson have "$have" '.[] | select(. as $w | $have | index($w) | not)' <<<"$wanted" |
    while read -r n; do
      if $DRY; then
        plan "add notification ${n} to budget ${name} (e-mail ${MASKED})"
      else
        aws budgets create-notification "${R[@]}" --account-id "$ACCOUNT" --budget-name "$name" \
          --notification "$(jq -c '{NotificationType: .type, ComparisonOperator: "GREATER_THAN", Threshold: .percent, ThresholdType: "PERCENTAGE"}' <<<"$n")" \
          --subscribers "$(jq -cn --arg e "$EMAIL" '[{SubscriptionType: "EMAIL", Address: $e}]')"
        done_ "notification ${n} added to budget ${name}"
      fi
    done
  jq -c --argjson want "$wanted" '.[] | select(. as $h | $want | index($h) | not)' <<<"$have" |
    while read -r n; do echo "[note] budget ${name} also has notification ${n} (left as is)"; done
}
budget yyt-cloudfront 5 '{"Service":["Amazon CloudFront"]}' \
  '[{"type":"ACTUAL","percent":20},{"type":"ACTUAL","percent":100},{"type":"FORECASTED","percent":100}]'
budget yyt-account 60 '{}' \
  '[{"type":"ACTUAL","percent":100},{"type":"FORECASTED","percent":100}]'

# 4. The old $30 budget goes only once its replacement exists.
OLD="$(maybe aws budgets describe-budget "${R[@]}" --account-id "$ACCOUNT" --budget-name yyt-30usd --output json)"
if [ "$OLD" = missing ]; then
  echo "[ok] budget yyt-30usd already gone"
elif $DRY; then
  plan "delete budget yyt-30usd (after yyt-account exists)"
else
  [ "$(maybe aws budgets describe-budget "${R[@]}" --account-id "$ACCOUNT" --budget-name yyt-account --output json)" != missing ]
  aws budgets delete-budget "${R[@]}" --account-id "$ACCOUNT" --budget-name yyt-30usd
  done_ "budget yyt-30usd deleted"
fi

# 5. The 11th CloudWatch alarm.
if [ "$(aws cloudwatch describe-alarms "${R[@]}" --alarm-names BillingAlarm --query 'length(MetricAlarms)' --output text)" = 0 ]; then
  echo "[ok] BillingAlarm already gone"
elif $DRY; then
  plan "delete CloudWatch alarm BillingAlarm (us-east-1); its SNS topic is left as is"
else
  aws cloudwatch delete-alarms "${R[@]}" --alarm-names BillingAlarm
  done_ "BillingAlarm deleted"
fi

if $DRY; then echo "(dry run; pass --apply)"; fi
