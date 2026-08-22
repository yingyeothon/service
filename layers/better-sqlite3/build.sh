#!/bin/bash
# Builds an arm64 Lambda layer for better-sqlite3 using its official prebuilt
# linux-arm64 binary (no Docker needed). Output: better-sqlite3-arm64.zip with
# the `nodejs/node_modules/better-sqlite3` layout Lambda expects.
# Rebuild whenever the Node runtime (NODE_TARGET, default 22.12.0 = Lambda nodejs22.x ABI 127)
# or the better-sqlite3 version changes.
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${1:-$(node -p "require('../../packages/sqlite-s3/package.json').dependencies['better-sqlite3'].replace(/^[\^~]/, '')")}"
rm -rf nodejs better-sqlite3-arm64.zip
mkdir -p nodejs
(
  cd nodejs
  npm init -y >/dev/null
  # prebuild-install reads npm_config_arch/platform and downloads the matching
  # release asset instead of compiling for the host.
  npm_config_arch=arm64 npm_config_platform=linux npm_config_libc=glibc \
    npm install --no-save --omit=dev --ignore-scripts "better-sqlite3@${VERSION}" >/dev/null
  (cd node_modules/better-sqlite3 && npm_config_arch=arm64 npm_config_platform=linux npm_config_libc=glibc \
    npx --yes prebuild-install --arch arm64 --platform linux --libc glibc --runtime node --target "${NODE_TARGET:-22.12.0}" --verbose)
  rm -f package.json package-lock.json
  rm -rf node_modules/better-sqlite3/{deps,src,build/Release/obj,build/Release/obj.target,build/Release/.deps}
  find node_modules -name '*.tar.gz' -delete
)
file nodejs/node_modules/better-sqlite3/build/Release/better_sqlite3.node
zip -qr better-sqlite3-arm64.zip nodejs
du -h better-sqlite3-arm64.zip
