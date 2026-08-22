# 확정 결정 (2026-08-22)

이 파일은 사용자와의 인터뷰로 확정된 결정의 단일 출처다. 바꾸려면 여기부터 고친다.

## 목적

- 잉여톤(해커톤) 당일 외에는 트래픽이 거의 없는 **대회 지원용 공용 서비스**.
- 최종 목표: tslib(`@yingyeothon/*`) + 이 service 로 7시간 대회 안에 캐주얼 MORPG(로비 HTTP API / 파티매칭 / 인스턴트 던전)를 만들되 **서버 구현은 2~3시간** 안에 끝낸다.
- 따라서 게임 쪽이 호출만 하면 되는 수준으로 인증·매칭·브로드캐스트를 미리 서비스화한다.

## 기술 스택

| 항목        | 결정                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 서버 언어   | TypeScript, Node 22 (`nodejs22.x`, arm64), ESM, Serverless Framework 4 + `serverless-esbuild`                                                                                                                                                                                                                                                                                                                   |
| CLI         | Go 단일 바이너리, goreleaser → GitHub Release (linux/mac/win)                                                                                                                                                                                                                                                                                                                                                   |
| 레포 구조   | pnpm 모노레포. `packages/*` 공용 라이브러리, `services/*` 배포 스택(console / auth / topic / match), `apps/console-web` SPA, `cli/` Go                                                                                                                                                                                                                                                                          |
| DB          | **(2026-08-22 변경)** 자체 운영 MariaDB 10.5(`<stateful-host>`, 관리 레포 `~/git/yyt.life/yyt-stateful`). stage 별 DB 1개 `yyt_svc_{stage}` 를 콘솔이 소유(스키마/마이그레이션/쓰기). auth/topic/match 는 `SELECT` 전용 계정으로 채널 설정만 읽는다. 계정 `svc_{service}_{stage}`, 자격증명은 `services/{service}/.env.{stage}`(gitignored) → SSM. sqlite-on-S3 + 락 구성은 폐기(`packages/sqlite-s3` 제거 예정) |
| 런타임 상태 | topic 접속 목록, 매칭 풀/티켓, 세션 등 휘발성 상태는 sqlite 가 아니라 **Redis 에만** 둔다                                                                                                                                                                                                                                                                                                                       |
| Redis       | Upstash **REST** (`@upstash/redis`) 만 사용. 키는 `{service}:{stage}:` prefix. tslib 의 naive-redis(TCP)는 게임 스택 전용 — 같은 Upstash 인스턴스를 prefix 로 나눠 써도 된다                                                                                                                                                                                                                                    |
| 인프라      | region `ap-northeast-2`, `AWS_PROFILE=yyt`, stage `dev`/`prod`, 도메인 `{console,auth,topic,match}.yyt.life` (`serverless-domain-manager`), SPA 는 S3+CloudFront                                                                                                                                                                                                                                                |
| 비밀/환경   | 상위 디렉토리 관례인 SSM SecureString `.envrc` (`get-envrc.sh`/`put-envrc.sh`) 유지. 런타임 시크릿은 `serverless.yml` 에서 `${ssm:/yyt-service/{stage}/...}`                                                                                                                                                                                                                                                    |
| 테스트      | vitest. Redis 는 인터페이스 뒤 in-memory fake, S3 는 `aws-sdk-client-mock`. Docker 불필요. 수동 검증은 dev 스테이지 배포 + `curl`/`wscat` 스모크                                                                                                                                                                                                                                                                |
| 커밋/푸시   | 적대적 리뷰 3개 후 `main` 직접 commit, GitHub `yingyeothon/service` 생성 후 push 자동                                                                                                                                                                                                                                                                                                                           |

## 권한 모델 (콘솔)

- 로그인: **GitHub OAuth 만**. 세션은 httpOnly cookie(콘솔 SPA) 또는 Bearer API 토큰(CLI).
- 역할: `admin` / `member` / `pending`. 가입만 하면 `pending`, 관리자가 승인해야 `member`.
- 최초 관리자: 환경변수 `ADMIN_GITHUB_LOGINS`(쉼표 구분)에 있는 GitHub login 은 로그인 시 자동 `admin`.
- 채널(auth/topic/match)은 생성자(`member` 이상) 소유. 관리자는 모든 채널 조회/연장/삭제 가능.
- 채널 기본 만료 7일, 7일씩 연장. 만료 시 비활성(API 401/410), 만료 30일 후 데이터 삭제.
- 시크릿은 생성 시 1회 노출, rotate 가능.

## auth 서비스

- 채널 = `{ channelId, secret(HS256), audience, tokenTtlSec(기본 86400), providers: { github?: {clientId, clientSecret}, google?: {clientId, clientSecret} } }`.
- 사용자는 **자기 OAuth app** 의 client id/secret 을 콘솔에 등록하고, 서버가 준 callback URL `https://auth.yyt.life/c/{channelId}/{provider}/callback` 을 그 app 에 설정한다.
- 발급 JWT: HS256, `iss = yyt-auth/{channelId}`, `aud = channel.audience`, `sub = userId`, `exp = iat + tokenTtlSec`. `userId = sha256(channelId + ":" + provider + ":" + providerUserId)` 의 앞 32 hex. PII(이름/이메일) 저장·클레임 모두 없음.
- 경로: `GET /c/{ch}/start?provider=&redirect=` → provider → `GET /c/{ch}/{provider}/callback` → `302 {redirect}#token=...&userId=...`. 수동: `POST /c/{ch}/token {provider, accessToken|idToken}` → `{jwt, userId, exp}`. 보조: `GET /c/{ch}/verify` (Bearer) → `{userId, exp}`.
- 게임 검증은 채널 secret 으로 로컬(tslib `createJwtRequestAuthorizer`, `docs/auth-game-contract.md` 규약 유지).

## topic 서비스

- 채널 생성(콘솔) → `{ channelId, apiKey, authChannelId, wsUrl }`.
- `POST /t` (Bearer apiKey) `{ allowUserIds?: string[], ttlSec?: ≤1200 }` → `{ topicId, wsUrl, expiresAt }`. **topic 수명 최대 20분**.
- 접속: `wss://topic.yyt.life/?topic={topicId}` + `Sec-WebSocket-Protocol: bearer, <auth JWT>`. 허용 조건: `allowUserIds` 에 있거나, 비어 있으면 연결된 auth 채널 JWT 검증 통과.
- 메시지: 서버가 `{ type:"msg", from:userId, seq, payload }` 로 감싸 **보낸 사람 포함 전원**에게 echo broadcast. 입장/퇴장은 `{type:"join"|"leave", userId}`. 상한 16KB. 이력 저장 없음.
- 상태: `topic:{stage}:t:{topicId}` (meta), `:conns` (set), `conn:{connId}` → topicId. 전부 TTL.

## match 서비스

- 채널 = `{ channelId, apiKey, authChannelId, partySize(2~16), waitTimeoutSec(60), onTimeout: "partial"|"fail", callbackUrl, wsUrl }`.
- 접속 = 티켓 제출: `wss://match.yyt.life/?channel={channelId}` + `bearer, <auth JWT>`. JWT 없거나 검증 실패 시 거부. 같은 userId 재접속은 이전 티켓 교체. 연결 해제 = 티켓 제거.
- 알고리즘: FIFO 만. 접속/해제 이벤트 시 즉시 시도 + EventBridge 1분 스케줄로 타임아웃 보조 처리(1분 최장 대기 계약은 "최대 ~2분 내 처리"로 문서화).
- 매칭 성공 → `POST callbackUrl` 본문 `{ matchId, channelId, members:[{userId}] , partial:boolean }`, 헤더 `X-Yyt-Signature: hmac-sha256(channel.apiKey, body)`. 응답 JSON(2xx)을 **그대로** 각 클라에 `{type:"matched", matchId, result}` 로 보내고 연결 종료. 콜백 실패/비2xx → `{type:"failed", reason}` 후 종료.
- 타임아웃: `partial` 이면 모인 인원으로 매칭 성공(`partial:true`), `fail` 이면 `{type:"failed", reason:"timeout"}` 후 종료.
- 콜백 대상은 topic 서비스(`POST /t`)일 수도, tslib 기반 던전 서버(`GameActorStartEvent` 생성 후 `{wsUrl, gameId, token}` 반환)일 수도 있다.

## 잉여톤 워크플로우 (콘솔)

- 이벤트 상태기계: `draft → proposing → voting → decided → published → closed`. 관리자가 전환.
- 제안/투표는 GitHub 로그인 필수, `pending` 도 가능. 제안 = 자유 텍스트(제목/본문: 날짜·장소·주제 포함). 1인 1표(변경 가능, voting 중).
- `decided` 에서 관리자가 당선 제안 선택 + 포스터 이미지(S3) 업로드 → `published` 시 공개 페이지 `/events/{id}` 에 노출.

## CLI (`yyt`)

- `yyt login --token <API 토큰>` (콘솔 > 내 계정 > API 토큰 발급에서 복사). `~/.config/yyt/config.json` 저장.
- 콘솔 API 전부를 서브커맨드로: `members`, `auth-channels`, `topic-channels`, `match-channels`, `events`, 각 `list/create/get/extend/rotate-secret/delete` 등. `--json` 출력.

## 우선순위

1 공용 패키지 → 2 auth → 3 콘솔 최소(로그인·멤버·채널 CRUD·API 토큰) → 4 match → 5 topic → 6 CLI → 7 잉여톤 워크플로우 → 8 콘솔 SPA 마감.
