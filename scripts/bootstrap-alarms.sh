#!/bin/bash
# Creates the stage-wide SNS topic every stack's CloudWatch alarms notify, subscribes
# an email address, and stores the topic ARN in SSM (/yyt-service/<stage>/alarm-topic-arn).
# Redeploy every stack of the stage afterwards (the ARN is resolved at deploy time).
# Usage: scripts/bootstrap-alarms.sh <dev|prod> <email>
# The subscription must be confirmed from the email AWS sends; until then alarms fire into nothing.
set -euo pipefail
STAGE="${1:?stage (dev|prod)}"; EMAIL="${2:?email}"
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ap-northeast-2}"
TOPIC="yyt-service-${STAGE}-alarms"
ARN="$(aws sns create-topic --name "$TOPIC" --query TopicArn --output text)"  # idempotent
aws sns subscribe --topic-arn "$ARN" --protocol email --notification-endpoint "$EMAIL" --query SubscriptionArn --output text
aws ssm put-parameter --name "/yyt-service/${STAGE}/alarm-topic-arn" --type String --value "$ARN" --overwrite >/dev/null
echo "topic ${TOPIC} stored in SSM; confirm the subscription email, then redeploy auth/console/topic/match ${STAGE}"
