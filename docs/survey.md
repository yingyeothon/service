# 사전 조사 요약 (2026-08-22)

## tslib (`~/git/yyt.life/tslib`)

- pnpm 모노레포, Node≥20 ESM, tsup dual build, vitest(커버리지 80/70 강제), ESLint9+prettier, OIDC npm publish. `CLAUDE.md`(=AGENTS.md 심링크) + `CONVENTIONS.md` + `rules/`.
- 규약: 클래스 export 금지(`create*` 팩토리), 옵션 객체, 라이브러리에서 `process.env`/`console` 금지, `logger?: Logger`.
- 접점: `lambda-authorizer-jwt.createJwtRequestAuthorizer`(sub→memberId, 서브프로토콜 bearer), `lambda-gamebase.handleConnect`(`resolveMemberId`, `selectSubprotocol`), `readyCall(callbackUrl)`, `GameActorStartEvent`, `Transport{send,drop}`. Redis 는 `naive-redis`(raw TCP). 매치메이커/던전 없음.

## 레거시 yyt.life

- 재활용: `lobby-api/src/match`(FIFO 매칭 + jest), `message-topic-broadcast/serverless.ts`(WS authorizer 설정), `ydeploy`(cookie authorizer, 콘솔 골격), SSM `.envrc` 패턴, `binary-distribution-api2`(SLS4+esbuild+node20 베이스라인).
- 폐기: `message-topic`, `message-broadcast`(node8), `management-console-web`(snowpack), `yyt-28-server`(EC2), `auth-api`/`lobby-api` 의 빌드 레이어(node12).
- 주의: 레거시는 `JWT_SECRET_KEY` 하나를 여러 스택이 복사해 씀 → 이번엔 채널별 secret.

## secret_vote (`~/git/dooroo/secret_vote/server-serverless`)

- Go + `modernc.org/sqlite`, S3 단일 파일 전체 다운로드/업로드, Upstash REST 직접 호출, 락 `SET NX EX 60` + 100ms×50 재시도 + Lua compare-and-delete. 락 키에 stage prefix 가 빠진 실수 있음(재현 금지). `rules/` 디렉토리 구조 참고.
