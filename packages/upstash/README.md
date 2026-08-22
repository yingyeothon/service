# @yyt/upstash

Upstash Redis(REST) 래퍼. 모든 키에 `{service}:{stage}:` prefix 를 붙인다(락 키·eval 키 포함).

## Public API

- `Kv` — get/set(nx,ex)/del/expire/ttl/incr/sadd/srem/smembers/scard/rpush/lrange/lrem/llen/hset/hget/hgetall/hdel/eval.
- `createUpstashKv({url, token, prefix, client?})` — 실제 구현. prefix 는 `:` 로 끝나야 한다.
- `createMemoryKv({prefix?, clock?})` — 테스트용 in-memory fake. `eval` 은 compare-and-delete 스크립트만 인식.
- `withLock(kv, key, {ttlSec=30, retryMs=100, maxWaitMs=5000, clock?, sleep?, logger?}, fn)` — `SET NX EX` 폴링 락, 해제는 Lua compare-and-delete. `LockTimeoutError`. 해제 실패는 `fn` 이 성공했을 때만 throw(실패 시엔 `fn` 의 오류 유지).
- `kvContractTests(api, make, tick)` — fake 와 실제 Upstash 에 같은 계약 테스트를 돌린다(`UPSTASH_TEST_URL`/`UPSTASH_TEST_TOKEN` 설정 시 실제 인스턴스도 검사).
