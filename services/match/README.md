# @yyt/service-match

`match.yyt.life` — FIFO party matchmaker over API Gateway WebSocket. Contract: `docs/decisions.md` §match service.

- `src/app.ts` — Lambda entry points: REQUEST authorizer, `$connect`/`$disconnect`/`$default`, async `worker`, EventBridge `tick`.
- `src/pool.ts` — Redis ticket/queue state (key layout in `rules/data.md`).
- `src/matcher.ts` — `tryMatch`/`sweep`/`tick`, deadline-bounded; dispatches via `src/dispatch.ts` (signed callback).
- `src/debug.ts` — dev-only HTTP API (`--param debugHooks=1`): callback sink, recorded-callback lookup, manual tick.

## Protocol

Connect to `wss://match.yyt.life/?channel={channelId}` with `Sec-WebSocket-Protocol: bearer, <auth JWT>` (the JWT is issued by the linked auth channel). Connecting submits the ticket.

| Direction | Message                                                  | Note                                                                        |
| --------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| client →  | `{"type":"ping"}`                                        | any other message is ignored                                                |
| ← server  | `{"type":"pong","position":n,"waited":sec}`              | 1-based queue position                                                      |
| ← server  | `{"type":"matched","matchId","partial","result"}`        | `result` = the callback's 2xx JSON (≤8 KB, `null` when empty); then close   |
| ← server  | `{"type":"failed","reason":"timeout\|callback\|closed"}` | `closed`: channel disabled/expired or no ticket for this socket; then close |
| ← server  | `{"type":"replaced"}`                                    | the same user connected again; this socket is no longer queued              |

The server never closes sockets; the client closes after a terminal message (idle sockets expire after 10 minutes).

## Operations

- Functions: `authorizer` (8), `ws` (10), `worker` (4, 45s), `tick` (1, 60s, `rate(1 minute)`), `debug` (1, dev only). Numbers are `reservedConcurrency`; each container holds one MySQL + one Redis connection.
- `$connect` enqueues and invokes `worker` asynchronously (a socket cannot be posted to from inside its own `$connect`); the worker waits ≤6s for `GetConnection`, takes the per-channel lock (30s TTL, 4s wait; yields quietly when held) and dispatches while ≥12s remain. `tick` skips channels whose lock is held and logs `tick incomplete` when it runs out of time.
- Alarms: `ws-errors`, `worker-errors`, `tick-errors` (Lambda Errors), `authorize-errors` (log metric on `"m":"authorize error"` — Redis/MySQL unreachable from the authorizer, which otherwise only denies), `message-count` (cost guard). Worker/tick have `maximumRetryAttempts: 0`; the next tick is the retry.
- Redis keys under `match:{stage}:` all carry TTLs; `result:{matchId}` (10 min) records who was dispatched and the outcome, never the callback payload.
- Channel config is cached 60s, so disabling a channel takes effect within a minute.
