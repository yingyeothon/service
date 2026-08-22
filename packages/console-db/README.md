# @yyt/console-db

콘솔 sqlite(`db/console.db`) 스키마와 리포지토리. 쓰기는 console 서비스만, auth/topic/match 는 읽기 전용으로 같은 파일을 연다.

## Public API

- `CONSOLE_MIGRATIONS`, `migrateConsoleDb(db)` — `user_version` 마이그레이션. `createSqliteS3({ migrate: migrateConsoleDb })` 로 넘긴다.
- `findChannelRow(db, id)` — 소프트 삭제 제외 원본 행.
- `findAuthChannel(db, id)` → `{ id, name, ownerId, config, secret, expiresAt, disabledAt }` — `config = {audience, tokenTtlSec, redirectAllowlist[], providers:{github?:{clientId}, google?:{clientId}}}`, `secret = {secret, providers:{github?:{clientSecret}, google?:{clientSecret}}}`. 만료 판단은 호출자가 한다(410 을 404 와 구분하기 위해).
- `insertChannel(db, input)`, `upsertMember(db, member)` — 쓰기 헬퍼(console, dev 디버그 시드).

02-console 에서 멤버/토큰/채널 CRUD 리포지토리가 추가된다.
