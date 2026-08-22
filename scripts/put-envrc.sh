#!/bin/bash
# Uploads ./.envrc to SSM as a SecureString (same convention as ~/git/yyt.life/put-envrc.sh).
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
cd "$(dirname "$0")/.."
NAME="$(pwd | cut -d'/' -f5- | tr '/' '.').envrc"
aws ssm put-parameter --name "${NAME}" --type SecureString --value "$(cat .envrc)" --overwrite
echo "${NAME}"
