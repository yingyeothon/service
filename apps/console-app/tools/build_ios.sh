#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export IOS_PROJECT_ROOT="${IOS_PROJECT_ROOT:-$PROJECT_ROOT}"
export IOS_BUILD_CONFIG="${IOS_BUILD_CONFIG:-$PROJECT_ROOT/ios/build.env}"

exec "$PROJECT_ROOT/tools/flutter_ios_build.sh" "$@"
