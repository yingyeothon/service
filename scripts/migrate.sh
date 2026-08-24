#!/bin/bash
# Usage: scripts/migrate.sh <dev|prod> [baseline]
#
# Runs `prisma migrate deploy` against the stage's console database using the
# MYSQL_* variables from gitignored `local/env/console.<stage>.env`. The
# database URL is assembled inside prisma.config.ts and never printed.
#
# `baseline` marks the initial migration (0_init) as already applied — run it
# once per pre-existing database (schema created by the legacy runtime
# migrator) before the first `migrate deploy`.
set -euo pipefail
STAGE="${1:?stage (dev|prod)}"
MODE="${2:-deploy}"
cd "$(dirname "$0")/.."
ENV_FILE="local/env/console.${STAGE}.env"
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
cd packages/console-db
case "$MODE" in
  deploy)
    # Both stage DBs pre-date Prisma; a DB where 0_init is still "pending" is
    # unbaselined and `migrate deploy` would try to re-create existing tables
    # (and record a failed migration needing `migrate resolve --rolled-back`).
    STATUS="$(pnpm exec prisma migrate status 2>&1 || true)"
    if grep -q "0_init" <<<"$STATUS" && grep -qi "have not yet been applied" <<<"$STATUS"; then
      echo "database is not baselined — run: scripts/migrate.sh ${STAGE} baseline" >&2
      exit 1
    fi
    pnpm exec prisma migrate deploy
    ;;
  baseline)
    # Refuse to mark the baseline applied when the live schema does not match
    # it — a DB behind the baseline (e.g. missing newer tables) would silently
    # "pass" deploy while the tables are absent (learned on prod, 2026-08-24).
    if ! pnpm exec prisma migrate diff --from-schema prisma/schema.prisma --to-config-datasource --exit-code >/dev/null 2>&1; then
      echo "schema drift vs prisma/schema.prisma detected — reconcile the database first (prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script)" >&2
      exit 1
    fi
    pnpm exec prisma migrate resolve --applied 0_init
    ;;
  status) pnpm exec prisma migrate status ;;
  *) echo "unknown mode $MODE (deploy|baseline|status)" >&2; exit 1 ;;
esac
