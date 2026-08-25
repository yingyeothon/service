#!/bin/bash
# Scans the FULL history reachable from the given refs (default: every local branch and tag) for
# stateful identifiers in added lines, using the gitignored local/identifiers.txt patterns.
# The range-only check in pre-push cannot see a leak that an older commit already carries, and CI
# cannot do this at all: gitleaks does not know these names and the patterns must not be published.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
if [ ! -s local/identifiers.txt ]; then
  echo "check-history-identifiers: local/identifiers.txt is missing or empty — run scripts/local-identifiers.sh" >&2
  exit 1
fi
refs=("$@")
[ ${#refs[@]} -gt 0 ] || refs=(--all)
hits=$(git log -p --format= "${refs[@]}" -- . ':!pnpm-lock.yaml' | grep -E '^\+' | grep -cE -f local/identifiers.txt || true)
if [ "${hits:-0}" -gt 0 ]; then
  echo "check-history-identifiers: $hits added line(s) in the history of ${refs[*]} carry stateful identifiers" >&2
  echo "check-history-identifiers: locate them with:" >&2
  echo "  for c in \$(git rev-list ${refs[*]}); do git grep -lE -f local/identifiers.txt \$c -- . ; done" >&2
  echo "check-history-identifiers: a leak already in history is not fixed by a new commit — rewrite it (git filter-repo --replace-text)" >&2
  exit 1
fi
echo "check-history-identifiers: clean (${refs[*]})"
