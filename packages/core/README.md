# @yyt/core

Shared primitives; every other package depends on it.

## Public API

- `ulid(time?)` — 26-char, time-sortable ULID.
- `nowSec(clock?)`, `nowMs(clock?)`, `Clock`, `systemClock` — injectable clock.
- `AppError(code, message?, {status?, details?, cause?})`, `isAppError`, `ErrorCode` — errors that map to HTTP statuses.
- `Role`, `ChannelKind`, `Logger`, `nullLogger`.
- `sha256Hex(input)`, `randomHex(bytes)`.
