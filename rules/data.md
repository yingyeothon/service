# Data

> 2026-08-22: storage moved to self-hosted MariaDB + Redis (host and account details live only in the local private ops repo `yyt-stateful` — never in this public repo). The sqlite-on-S3 sections below describe the previous design and stay only until the migration in `todo/index.md` "다음 작업 0" lands; do not build new code on them.

## Accounts and environments

- One MySQL database per stage (name in `yyt-stateful`), owned by console (only writer, owns migrations). auth/topic/match use `SELECT`-only accounts.
- One MySQL account and one Redis ACL user per service×stage. Redis ACL users are restricted to keys/channels `{service}:{stage}:*` (`resetkeys ~… resetchannels &…`, `+@all -@dangerous`), so a wrong prefix fails with NOPERM instead of leaking — keep the `{service}:{stage}:` prefix rule anyway for readability.
- Credentials live in `local/env/{service}.{stage}.env` (gitignored; layout in `local/env.example`, see `local/README.md`) and are pushed to SSM for Lambda. Never commit or log them. Rotate via `yyt-stateful` scripts (`ALTER USER` / `ACL SETUSER … >pw` + `ACL SAVE`) and update the `.env` in the same step.
- Redis 6.2 quirk: a new ACL user starts with `allchannels`; adding `&pattern` errors unless `resetchannels` precedes it.
- Host limits (see `yyt-stateful`): Redis `maxmemory 256mb allkeys-lru` (every runtime key still needs a TTL; eviction is a safety net, not a design), MariaDB `max_connections=60` — keep Lambda pools tiny (1 connection per container) and prefer short-lived connections.

## sqlite on S3

- One file per service (`db/console.db`); the owning service is the only writer.
- Write path: `withLock(kv, "{service}:{stage}:lock:db", {ttl 30s, retry 100ms, maxWait 5s})` → download → mutate in a transaction → `PutObject` → update local ETag. Never write without the lock; never hold it across network calls other than the S3 upload.
- Read path: HEAD for ETag, download to `/tmp` only if changed, open read-only. Stale reads up to one write are acceptable; runtime decisions that need freshness (ticket counts, connections) belong in Redis, not sqlite.
- Schema changes via `user_version` migrations in `packages/console-db`; every migration gets a test that upgrades a fixture DB.
- Daily backup to `db/backups/`; S3 versioning on as a second safety net.

## Redis (Upstash REST)

- Every key starts with `{service}:{stage}:` — including lock keys (secret_vote forgot this; don't).
- Every runtime key has a TTL. Channel config cache 60s; topic keys = topic TTL (≤20m); match tickets = waitTimeout+120s; OAuth state 10m; console sessions 7d.
- Prefer a Lua `eval` for compare-and-delete and multi-key atomic steps; otherwise serialize with `withLock`.
- Do not store secrets in Redis except short-lived session ids; secrets stay in sqlite.

## Expiry

- Channels: `expires_at` default +7d, extend +7d (cap now+28d); disabled on expiry; deleted (secrets wiped) 30d later by the console `expire` cron.
- `sqliteS3.write` uploads with `IfMatch`(existing)/`IfNoneMatch: *`(new) so a write whose lock expired gets `AppError("conflict")` instead of clobbering; callers may retry once. Every download is migrated locally, so reads never fail on a schema the running code is newer than.
- `read`/`write` callbacks are synchronous: better-sqlite3 transactions cannot contain `await`; do network work (Redis, fetch) outside the callback.
- Readers of another service's sqlite file do **not** add a Redis cache when the rows contain secrets (auth channels): `sqliteS3.read()` is one HEAD per request plus a warm `/tmp` copy, which is cheap enough. The "60s channel cache" rule applies to topic/match config without secrets.
- A service that must (dev-only) write another service's DB builds a second `Kv` with the _owner's_ prefix (`console:{stage}:`) for the lock key so all writers contend on the same lock.
