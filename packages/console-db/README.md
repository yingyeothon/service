# @yyt/console-db

콘솔이 소유하는 MySQL(MariaDB) 스키마와 리포지토리. console 은 쓰기 계정으로 마이그레이션·쓰기를, auth/topic/match 는 `SELECT` 전용 계정으로 같은 리포지토리를 읽기만 한다. 호스트·계정 정보는 private `yyt-stateful` 레포와 `local/env/*.env` 에만 있다.

## Public API

- `createMysqlDb({host, port, database, user, password, pool?})` → `Db` (`query/execute/transaction/close`). 커넥션 1개짜리 풀 — Lambda 컨테이너당 1개를 만들어 재사용한다. 드라이버 오류는 `AppError("conflict")`(중복 키) / `AppError("unavailable")` 로 바뀌고 SQL·값은 메시지에 실리지 않는다.
- `mysqlOptionsFromEnv(env?, prefix = "MYSQL_")` — `MYSQL_HOST/PORT/DATABASE/USER/PASSWORD` 를 읽는다. prefix 를 바꾸면 다른 계정(예: dev 디버그 시드용 `DEBUG_MYSQL_`)을 읽을 수 있다.
- `migrateConsoleDb(db, steps?)` — `schema_migrations` 테이블 + `GET_LOCK` 으로 직렬화. **console 만** 호출한다.
- `createConsoleDb(db)` → `ConsoleDb` (`findChannelRow/findAuthChannel/insertChannel/upsertMember`).
- `createMemoryConsoleDb()` — 테스트용 fake(같은 계약 + `patchChannel` 헬퍼).

## 테스트

- 단위: fake `Db` 로 SQL/파라미터 매핑 확인, `createMemoryConsoleDb` 계약.
- 통합(opt-in): `YYT_IT=1 pnpm test` 이고 `local/env/console.dev.env` 가 있으면 dev DB 에 마이그레이션을 적용하고 고유 id 로 round-trip 뒤 정리한다.
