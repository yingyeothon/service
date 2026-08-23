#!/usr/bin/env bash
# Cross-compiles `yyt` for every supported platform into cli/dist/ with archives + checksums.
# Usage: cli/scripts/build-release.sh <version>   (e.g. 1.2.0; run from anywhere)
set -euo pipefail
version=${1:?version (e.g. 1.2.0)}
cd "$(dirname "$0")/.."
rm -rf dist && mkdir -p dist
ldflags="-s -w -X github.com/yingyeothon/service/cli/internal/api.Version=${version}"
for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64; do
  os=${target%/*}; arch=${target#*/}
  name="yyt_${version}_${os}_${arch}"
  work="dist/${name}"; mkdir -p "$work"
  bin=yyt; [ "$os" = windows ] && bin=yyt.exe
  CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags "$ldflags" -o "$work/$bin" ./cmd/yyt
  cp README.md "$work/"
  if [ "$os" = windows ]; then
    (cd "$work" && zip -q "../${name}.zip" "$bin" README.md)
  else
    tar -C "$work" -czf "dist/${name}.tar.gz" "$bin" README.md
  fi
  rm -rf "$work"
  echo "built $name"
done
(cd dist && sha256sum -- *.tar.gz *.zip > checksums.txt)
