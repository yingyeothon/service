# Data

> Storage is self-hosted MariaDB + Redis (host and account details live only in the local private ops repo `yyt-stateful` — never in this public repo). The previous sqlite-on-S3 + Upstash design was removed on 2026-08-22 (`todo/09-storage-migration.md`).

## Accounts and environments

- One MySQL database per stage (name in `yyt-stateful`), owned by console (only writer, owns migrations). auth/topic/match use `SELECT`-only accounts.
- One MySQL account and one Redis ACL user per service×stage. Redis ACL users are restricted to keys/channels `{service}:{stage}:*` (`resetkeys ~… resetchannels &…`, `+@all -@dangerous`), so a wrong prefix fails with NOPERM instead of leaking — keep the `{service}:{stage}:` prefix rule anyway for readability.
- Credentials live in `local/env/{service}.{stage}.env` (gitignored; layout in `local/env.example`, see `local/README.md`) and are pushed to SSM for Lambda. Never commit or log them. Rotate via `yyt-stateful` scripts (`ALTER USER` / `ACL SETUSER … >pw` + `ACL SAVE`) and update the `.env` in the same step.
- Redis 6.2 quirk: a new ACL user starts with `allchannels`; adding `&pattern` errors unless `resetchannels` precedes it.
- Host limits (see `yyt-stateful`): Redis `maxmemory 256mb allkeys-lru` (every runtime key still needs a TTL; eviction is a safety net, not a design), MariaDB `max_connections=60` — keep Lambda pools tiny (1 connection per container) and prefer short-lived connections.

## MySQL (console-owned)

- Schema lives in `@yyt/console-db` `CONSOLE_MIGRATIONS` (append-only steps, `schema_migrations` table, `GET_LOCK` serializes concurrent cold starts). Only console's account may run `migrateConsoleDb`; it runs at console cold start and in the `YYT_IT=1` integration test.
- Times are unix seconds in `bigint`; JSON configs are `mediumtext` parsed in code. MariaDB returns `bigint` as JS numbers up to 2^53 (`supportBigNumbers` + `bigNumberStrings:false`); repositories still coerce with `Number()` so a string never leaks into comparisons.
- `Db` maps driver errors: `ER_DUP_ENTRY` → `AppError("conflict")`, everything else → `AppError("unavailable")` with the driver error as `cause` (never in the message — messages reach clients). A SELECT-only account hitting an INSERT therefore surfaces as 503, not 500.
- Pool: `connectionLimit: 1`, `maxIdle: 1`, `queueLimit: 1` (a second waiter is our own re-entrancy bug — fail fast), `idleTimeout` 60s, `connectTimeout` 3s, keep-alive on, `SET SESSION max_statement_time=5` on every new connection (mysql2 has no per-query timeout), built once per Lambda container. Never open a pool per request.
- Connection budget: a frozen/reaped container never closes its socket, so the server holds it until `wait_timeout`. Every function sets `reservedConcurrency` (auth: 10; budget ≈50 across the four stacks) and `yyt-stateful` must set a short `wait_timeout` (≈120s) — tracked in `todo/07-infra.md`. Dev with debug hooks uses two pools per container.
- `Db.transaction` pins one connection; inside the callback use only `tx` (the outer handle would wait for the same connection and the pool rejects it). A connection whose rollback/commit failed is destroyed, never released back. `migrateConsoleDb` runs inside `transaction` because `GET_LOCK` is per-session; lock wait is 5s (< Lambda timeout).
- `upsertMember` updates only when the `github_id` matched; a colliding _id_ with another `github_id` is a no-op + `AppError("conflict")`, and the call returns the id that owns the GitHub user — use that id for foreign keys (the debug seed learned this the hard way).
- Writers that are not console (dev-only debug seeding in auth) use console's dev account through separate `DEBUG_MYSQL_*` env (`docs/decisions.md` "디버그 시드"); the code path must degrade to "hooks disabled" when those vars are absent.

## Redis (ioredis, TCP)

- Every key starts with `{service}:{stage}:` — the `REDIS_KEY_PREFIX` env must equal `{service}:{stage}:` and handlers assert it at cold start. The ACL user enforces the same pattern; a mismatch shows up as `NOPERM`.
- ACL users have `-@dangerous`, which removes `INFO`: set `enableReadyCheck: false` in ioredis or every connection logs "Skipping the ready check" and waits. `KEYS`/`FLUSHALL`/`CLIENT` are also unavailable — design without them (no key scans; track membership in sets with TTLs).
- Every runtime key has a TTL. Channel config cache 60s (never for rows with secrets); topic keys = topic TTL (≤20m); match tickets = waitTimeout+120s; OAuth state 10m; console sessions 7d.
- Prefer a Lua `eval` for compare-and-delete and multi-key atomic steps; otherwise serialize with `withLock`.
- Client options: `lazyConnect`, `connectTimeout` 2s, `commandTimeout` 3s, `maxRetriesPerRequest: 1` (unreachable host fails in ≈4s, inside the 10s Lambda timeout), `enableAutoPipelining`, an `error` listener that logs through `Logger` (otherwise ioredis spams `console.error`). Every command error becomes `AppError("unavailable")` with cause `redis <code>`. One client per container; `close()` exists for tests, Lambda just lets the container die.
- Do not store secrets in Redis except short-lived session ids; secrets stay in MySQL.

## Expiry

- Readers of auth channels do **not** add a Redis cache (rows contain secrets); one SELECT per request is cheap. The 60s cache rule applies to topic/match config without secrets.
- Channels: `expires_at` default +7d, extend +7d (cap now+28d); disabled on expiry; deleted (secrets wiped) 30d later by the console `expire` cron.
