# @yyt/console-db

Console-owned MySQL (MariaDB) schema and repositories. console migrates and writes with its own account; auth/topic/match read through the same repository with `SELECT`-only accounts. Host/account details exist only in the private `yyt-stateful` repo and `local/env/*.env` (`docs/secrets.md`).

## Public API

- `createMysqlDb({host, port, database, user, password, pool?})` → `Db` (`query/execute/transaction/close`). One-connection pool per Lambda container. Driver errors become `AppError("conflict")` (duplicate key) or `AppError("unavailable")`; SQL and values never reach messages. Inside `transaction` use only `tx`.
- `mysqlOptionsFromEnv(env?, prefix = "MYSQL_")` — reads `MYSQL_HOST/PORT/DATABASE/USER/PASSWORD`; another prefix selects another account (e.g. `DEBUG_MYSQL_` for dev seeding).
- `migrateConsoleDb(db, steps?)` — `schema_migrations` table + `GET_LOCK`; **console only**.
- `createConsoleDb(db)` → `ConsoleDb` (`findChannelRow/findAuthChannel/insertChannel/upsertMember`). `upsertMember` returns the id that owns the GitHub user — use it for foreign keys.
- `createMemoryConsoleDb()` — test fake with the same contract plus `patchChannel`.
- `createPushDb(prisma)` → `PushDb` (`m0028_push`): the registration claim (`claimApp`, one transaction for the stage-wide package name among `platform` claims, the team cap and the pool slot), pool slots (`closeSlot`/`openSlot`), device tokens keyed per channel (`putToken`, `listTokensForUsers`, bounded deletes) and the per-channel daily send counters (`addSendStats`, `topSendFailures`, bounded deletes). `ConsoleDb.editChannel` is the row-locked read-modify-write every writer of a push channel's config and secret goes through. The caps and grammars both stacks share are constants of this module. `createMemoryPushDb({channel})` is the fake. No method returns a token to anything but the platform's sender; rules in `rules/data.md` _Push_.

## Tests

- Unit: fake `Db` records SQL/params; `createMemoryConsoleDb` contract.
- Integration (opt-in): `YYT_IT=1 pnpm test` with `local/env/console.dev.env` migrates the dev DB, round-trips a unique id, and cleans up.
