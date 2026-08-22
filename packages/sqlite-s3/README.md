# @yyt/sqlite-s3

S3 에 보관하는 sqlite 파일 1개를 Lambda `/tmp` 에 캐시하며 읽고, Redis 락 아래에서 쓴다.

## Public API

- `createSqliteS3({bucket, key, localDir="/tmp", kv, lockKey, migrate?, s3?, lock?, clock?, logger?})`
  - `read(fn)` — HEAD 로 ETag 비교, 바뀐 경우에만 다운로드, read-only 오픈. 객체가 없으면 빈 DB 에 `migrate` 적용.
  - `write(fn)` — `withLock` → 무조건 다운로드 → `migrate` → 트랜잭션 안에서 `fn` → 조건부 `PutObject`(`IfMatch`/`IfNoneMatch:*`). `fn` 이 throw 하면 롤백·업로드 없음. 락 만료 등으로 S3 가 바뀌어 있으면 `AppError("conflict")`.
  - `read`/`write` 콜백은 **동기** 함수여야 한다(better-sqlite3 트랜잭션). 다운로드마다 로컬에서 `migrate` 를 적용하므로 새 배포가 옛 파일을 읽어도 된다.
  - `backup()` — `${key}.backups/{yyyymmdd-hhmmss}.db` 로 복사.
  - `reset()` — 로컬 캐시 폐기.
- `migrate(db, steps)` / `MigrationStep {version, up(db)}` — `PRAGMA user_version` 기반, 1..n 연속 필수, 단계마다 트랜잭션.

런타임에서는 `better-sqlite3` 가 esbuild external 이며 `layers/better-sqlite3` 레이어가 제공한다.
