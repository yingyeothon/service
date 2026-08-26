#!/bin/bash
# Usage: scripts/migrate.sh <dev|prod> [deploy|baseline|status] [--allow-contract]
#
# Runs `prisma migrate deploy` against the stage's console database using the
# MYSQL_* variables from gitignored `local/env/console.<stage>.env`. The
# database URL is assembled inside prisma.config.ts and never printed.
#
# `baseline` marks the initial migration (0_init) as already applied — run it
# once per pre-existing database (schema created by the legacy runtime
# migrator) before the first `migrate deploy`.
#
# A pending migration whose SQL starts with `-- contract` (NOT NULL, unique
# indexes, drops — nothing DDL can roll back) is applied only with
# `--allow-contract`, and only after scripts/contract-preflight.mjs finds no
# unmapped rows, duplicate names in a team, or reserved names (rules/data.md).
# That script needs packages/console-db/dist: run `pnpm -r build` first when
# calling migrate.sh by hand.
set -euo pipefail
STAGE="${1:?stage (dev|prod)}"
MODE="${2:-deploy}"
ALLOW_CONTRACT=0
for arg in "${@:3}"; do
  case "$arg" in
    --allow-contract) ALLOW_CONTRACT=1 ;;
    *) echo "unknown option $arg" >&2; exit 1 ;;
  esac
done
cd "$(dirname "$0")/.."
ROOT="$PWD"
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
    # The gate reads the status output, so an unreadable status must fail
    # closed: a transient error would otherwise look like "nothing pending"
    # and `migrate deploy` would apply a contract file unchecked.
    if ! grep -q "is up to date" <<<"$STATUS" && ! grep -qi "have not yet been applied" <<<"$STATUS"; then
      echo "$STATUS" >&2
      echo "could not read migration status — not deploying" >&2
      exit 1
    fi
    # Pending migrations are listed one name per line in the status output.
    CONTRACT=""
    for dir in prisma/migrations/*/; do
      name="$(basename "$dir")"
      if grep -qx "$name" <<<"$STATUS" && [[ "$(head -n1 "$dir/migration.sql")" == "-- contract"* ]]; then
        CONTRACT="$CONTRACT $name"
      fi
    done
    if [[ -n "$CONTRACT" ]]; then
      if [[ "$ALLOW_CONTRACT" != 1 ]]; then
        echo "pending contract migration(s):$CONTRACT — take a dump, then rerun with --allow-contract" >&2
        exit 1
      fi
      (cd "$ROOT" && node scripts/contract-preflight.mjs "$STAGE") || {
        echo "contract preflight failed — fix the rows above before applying:$CONTRACT" >&2
        exit 1
      }
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
