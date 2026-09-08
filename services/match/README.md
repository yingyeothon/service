# @yyt/service-match

`match.yyt.life` — FIFO party matchmaker over API Gateway WebSocket. Contract: `docs/decisions.md` §match service.

- `src/app.ts` — Lambda entry points: REQUEST authorizer, `$connect`/`$disconnect`/`$default`, async `worker`, EventBridge `tick`.
- `src/pool.ts` — Redis ticket/queue state (key layout in `rules/data.md`).
- `src/matcher.ts` — `tryMatch`/`sweep`/`tick`, deadline-bounded; dispatches via `src/dispatch.ts` (signed callback).
- `src/debug.ts` — dev-only HTTP API (`--param debugHooks=1`): callback sink, recorded-callback lookup, manual tick.

## Protocol

Connect to `wss://match.yyt.life/?channel={channelId}` with `Sec-WebSocket-Protocol: bearer, <auth JWT>` (the JWT is issued by the linked auth channel). Connecting submits the ticket.

A channel has a callback or it does not. With `callbackUrl` the formed party is
posted there and the answer becomes `result`; **without one nothing leaves the
stack** — the party is announced to its own sockets and `members` is what the
game builds a room from (`docs/decisions.md` _Serverless clients_ #8). The
documented client recipe is that the lowest `userId` runs `party.create` on the
game's lobby channel and invites the rest.

| Direction | Message                                                     | Note                                                                                                                                                 |
| --------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| client →  | `{"type":"ping"}`                                           | any other message is ignored                                                                                                                         |
| ← server  | `{"type":"pong","position":n,"waited":sec}`                 | 1-based queue position                                                                                                                               |
| ← server  | `{"type":"matched","matchId","partial","result","members"}` | `members` = the party in ticket order; `result` = the callback's 2xx JSON (≤8 KB, `null` when empty or when the channel has no callback); then close |
| ← server  | `{"type":"failed","reason":"timeout\|callback\|closed"}`    | `closed`: channel disabled/expired or no ticket for this socket; then close                                                                          |
| ← server  | `{"type":"replaced"}`                                       | the same user connected again; this socket is no longer queued                                                                                       |

The server never closes sockets; the client closes after a terminal message (idle sockets expire after 10 minutes).

## Operations

- Functions: `authorizer` (8), `ws` (10), `worker` (4, 45s), `tick` (1, 60s, `rate(1 minute)`), `debug` (1, dev only). Numbers are `reservedConcurrency`; each container holds one MySQL + one Redis connection.
- `$connect` enqueues and invokes `worker` asynchronously (a socket cannot be posted to from inside its own `$connect`); the worker waits ≤6s for `GetConnection`, takes the per-channel lock (30s TTL, 4s wait; yields quietly when held) and dispatches while ≥12s remain. `tick` skips channels whose lock is held and logs `tick incomplete` when it runs out of time.
- Alarms (account-wide 10-alarm free-tier budget, `rules/serverless-aws.md`): `ws-errors` (both stages), `tick-errors` (prod only). Worker errors, throttles, the authorizer log metric and the message-count guard were removed on 2026-08-26; check those metrics by hand. Worker/tick have `maximumRetryAttempts: 0`; the next tick is the retry.
- Redis keys under `match:{stage}:` all carry TTLs; `result:{matchId}` (10 min) records who was dispatched and the outcome, never the callback payload.
- A channel without a `callbackUrl` makes no outbound request and reads no secret (`getMatchWithSecret` is skipped), so `failed reason:"callback"` cannot occur on it; the `result:{matchId}` record is written in both modes. `match dispatched` carries `mode: callback | members`, which is what a "the match landed and nothing happened" report is filtered on — in the members-only mode the room is formed entirely by the clients, so the stack's last word is that line.
- **Deploy match before console** when the optional-callback bundle rolls out to a stage (`rules/deployment.md`): a console that can already store a config without the key, in front of a match that still expects one, fails every match on such a channel with `failed:callback`.
- Changing the mode is subject to the same 60 s config cache as every other config edit: for up to a minute after clearing a `callbackUrl` the stack still POSTs to it, and for up to a minute after setting one clients still get `result:null`. Wait it out before concluding the edit did not take.
- Channel config is cached 60s, so disabling a channel takes effect within a minute.
