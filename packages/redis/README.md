# @yyt/redis

Wrapper over self-hosted Redis (`ioredis`, TCP). Every key gets the `{service}:{stage}:` prefix (lock and `eval` keys included); the Redis ACL user is restricted to the same pattern, so a wrong prefix fails with NOPERM.

## Public API

- `Kv` — get/set(nx,ex)/del/expire/ttl/incr/sadd/srem/smembers/scard/rpush/lrange/lrem/llen/hset/hget/hgetall/hdel/eval.
- `createRedisKv({host, port, username, password, prefix, client?, logger?})` — real implementation (+`close()`). One per Lambda container, reused. Prefix must end with `:`. Driver errors become `AppError("unavailable")` with cause `redis <code>`.
- `redisOptionsFromEnv(env?)` — reads `REDIS_HOST/PORT/USER/PASSWORD/KEY_PREFIX` (the `local/env/*.env` layout pushed to SSM).
- `createMemoryKv({prefix?, clock?})` — in-memory fake; `eval` recognises only the compare-and-delete script.
- `withLock(kv, key, {ttlSec=30, retryMs=100, maxWaitMs=5000, clock?, sleep?, logger?}, fn)` — `SET NX EX` polling lock released by Lua compare-and-delete; `LockTimeoutError`.
- `kvContractTests(api, make, tick)` — same contract cases for the fake and, with `YYT_IT=1` + `local/env/auth.dev.env`, the real dev Redis.

Every runtime key needs a TTL (`maxmemory allkeys-lru` is a safety net, not a design).
