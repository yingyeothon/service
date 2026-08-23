#!/bin/sh
# Installs the latest `yyt` release binary into $BINDIR (default /usr/local/bin or ~/.local/bin).
# Usage: curl -fsSL https://raw.githubusercontent.com/yingyeothon/service/main/cli/install.sh | sh
set -eu
REPO=yingyeothon/service
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "unsupported arch: $arch" >&2; exit 1 ;;
esac
case "$os" in linux|darwin) ;; *) echo "unsupported os: $os (download from GitHub Releases)" >&2; exit 1 ;; esac
# YYT_VERSION=v1.2.0 pins a release; otherwise the newest cli/v* release is used.
tag=${YYT_VERSION:-$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=100" \
  | grep -o '"tag_name": *"cli/v[^"]*"' | head -1 | sed 's/.*"cli\/\(v[^"]*\)"/\1/')}
[ -n "$tag" ] || { echo "no cli/v* release found" >&2; exit 1; }
ver=${tag#v}
url="https://github.com/$REPO/releases/download/cli%2F$tag/yyt_${ver}_${os}_${arch}.tar.gz"
sums="https://github.com/$REPO/releases/download/cli%2F$tag/checksums.txt"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
echo "downloading yyt $tag ($os/$arch)"
curl -fsSL "$url" -o "$tmp/yyt.tgz"
curl -fsSL "$sums" -o "$tmp/checksums.txt"
expected=$(grep " yyt_${ver}_${os}_${arch}.tar.gz\$" "$tmp/checksums.txt" | cut -d' ' -f1)
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/yyt.tgz" | cut -d' ' -f1)
else
  actual=$(shasum -a 256 "$tmp/yyt.tgz" | cut -d' ' -f1)
fi
[ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "checksum mismatch" >&2; exit 1; }
tar -xzf "$tmp/yyt.tgz" -C "$tmp" yyt
BINDIR=${BINDIR:-$( [ -w /usr/local/bin ] && echo /usr/local/bin || echo "$HOME/.local/bin" )}
mkdir -p "$BINDIR"
install -m 0755 "$tmp/yyt" "$BINDIR/yyt"
echo "installed $BINDIR/yyt ($("$BINDIR/yyt" --version))"
case ":$PATH:" in *":$BINDIR:"*) ;; *) echo "note: $BINDIR is not on your PATH" ;; esac
