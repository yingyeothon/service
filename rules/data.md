# Data

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
