# @yyt/redis

자체 운영 Redis(TCP, `ioredis`) 래퍼. 모든 키에 `{service}:{stage}:` prefix 를 붙인다(락 키·eval 키 포함). Redis ACL 유저도 같은 패턴으로 제한되어 있어 prefix 가 틀리면 NOPERM 이 난다.

## Public API

- `Kv` — get/set(nx,ex)/del/expire/ttl/incr/sadd/srem/smembers/scard/rpush/lrange/lrem/llen/hset/hget/hgetall/hdel/eval.
- `createRedisKv({host, port, username, password, prefix, client?})` — 실제 구현(+`close()`). Lambda 컨테이너당 1개를 만들어 재사용한다(호스트 연결 수가 작다). prefix 는 `:` 로 끝나야 한다.
- `redisOptionsFromEnv(env?)` — `REDIS_HOST/PORT/USER/PASSWORD/KEY_PREFIX` 를 읽는다(`local/env/*.env` → SSM 레이아웃).
- `createMemoryKv({prefix?, clock?})` — 테스트용 in-memory fake. `eval` 은 compare-and-delete 스크립트만 인식.
- `withLock(kv, key, {ttlSec=30, retryMs=100, maxWaitMs=5000, clock?, sleep?, logger?}, fn)` — `SET NX EX` 폴링 락, 해제는 Lua compare-and-delete. `LockTimeoutError`.
- `kvContractTests(api, make, tick)` — fake 와 실제 Redis 에 같은 계약 테스트를 돌린다. `YYT_IT=1` 이고 `local/env/auth.dev.env` 가 있으면 실제 dev Redis 에도 실행(opt-in).

모든 런타임 키는 TTL 이 있어야 한다(`maxmemory 256mb allkeys-lru` 는 안전망일 뿐).
