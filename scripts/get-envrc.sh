#!/bin/bash
# Prints the .envrc stored in SSM for this checkout (same convention as ~/git/yyt.life/get-envrc.sh).
set -euo pipefail
export AWS_PROFILE="${AWS_PROFILE:-yyt}"
cd "$(dirname "$0")/.."
NAME="$(pwd | cut -d'/' -f5- | tr '/' '.').envrc"
aws ssm get-parameter --name "${NAME}" --with-decryption | jq -r ".Parameter.Value"
