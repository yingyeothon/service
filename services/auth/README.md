# services/auth — `auth.yyt.life`

채널별 OAuth(GitHub/Google) 로그인으로 HS256 채널 JWT 를 발급한다. 계약은 `docs/decisions.md` §auth, 게임 쪽 검증 규약은 `docs/auth-game-contract.md`.

## 엔드포인트

| 경로                                                  | 설명                                                                                    |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /c/{ch}/.well-known/config`                      | 공개 설정(`issuer`, `audience`, `providers`, `callbackUrls`, `startUrl`, `tokenTtlSec`) |
| `GET /c/{ch}/start?provider=github\|google&redirect=` | state 발급 후 provider authorize 로 302. `redirect` 는 채널 allowlist 접두어 필수       |
| `GET /c/{ch}/{provider}/callback?code&state`          | code 교환 → JWT → `302 {redirect}#token=&userId=&exp=`                                  |
| `POST /c/{ch}/token {provider, accessToken\|idToken}` | 수동 발급 → `{jwt, userId, exp}`                                                        |
| `GET /c/{ch}/verify` (Bearer)                         | `{userId, exp, channelId}` / 401                                                        |

없는 채널 404, 만료/비활성 410. 브라우저 경로(`/start`, `/callback`)의 오류는 최소 HTML.

- `/start` 는 `__Host-yyt_auth_nonce` 쿠키(10분)를 심고 state 에 그 해시를 저장한다. `/callback` 은 같은 브라우저의 쿠키가 있어야 통과(로그인 CSRF 방지). state 는 1회용.
- `redirect` allowlist 는 **origin 완전 일치 + path 접두어(`/` 경계)** 로 비교한다. 항목은 절대 URL 이어야 한다(`https://game.example` 는 `https://game.example.evil/` 을 허용하지 않는다).
- GitHub 는 `POST /applications/{clientId}/token`(token check) 으로 **이 채널의 OAuth app 에 발급된 토큰인지** 확인한 뒤 `user.id` 를 쓴다. Google 은 id_token 의 `aud = clientId`.

## 데이터

- 채널: 콘솔 DB(`s3://yyt-service-{stage}/db/console.db`)를 `@yyt/sqlite-s3` 로 **읽기 전용** 열람(ETag 캐시). Redis 캐시 없음 — secret 을 Redis 에 두지 않기 위해.
- Redis(`auth:{stage}:`): `state:{state}` TTL 600s, `issued:{channelId}:{yyyymmdd}` 카운터(40일).

## 환경변수 (`serverless.yml`)

`STAGE`, `PUBLIC_BASE_URL`, `DB_BUCKET`, `UPSTASH_REDIS_REST_URL`/`_TOKEN`(SSM `/yyt-service/{stage}/upstash-url|token`), `DEBUG_HOOKS`(`--param debugHooks=1`, dev 전용), `DEBUG_KEY`(SSM `debug-key`).

## 디버그 훅 (dev + `DEBUG_HOOKS=1` 일 때만 등록)

- `POST /debug/channels` (`x-debug-key`) `{id?, audience?, tokenTtlSec?, redirectAllowlist?, providers?}` → `{channelId, secret, ...}` — 콘솔 DB 에 채널 시드.
- `POST /debug/token` (`x-debug-key`) `{channelId, userId}` → `{jwt, userId, exp}`.

## 배포/검증

```bash
UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... scripts/bootstrap-ssm.sh dev   # 최초 1회
scripts/deploy.sh auth dev --param debugHooks=1
scripts/smoke/auth.mjs https://auth-dev.yyt.life <debug-key>
```
