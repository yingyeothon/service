# @yyt/core

공용 원시 타입·유틸. 다른 모든 패키지가 의존한다.

## Public API

- `ulid(time?)` — 26자 ULID(시간순 정렬).
- `nowSec(clock?)`, `nowMs(clock?)`, `Clock`, `systemClock` — 주입 가능한 시계.
- `AppError(code, message?, {status?, details?, cause?})`, `isAppError`, `ErrorCode` — HTTP 상태로 매핑되는 오류.
- `Role`, `ChannelKind`, `Logger`, `nullLogger`.
- `sha256Hex(input)`, `randomHex(bytes)`.
