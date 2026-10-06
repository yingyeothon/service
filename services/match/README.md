# @yyt/service-match

`match.yyt.life` — FIFO party matchmaker over API Gateway WebSocket (`live` mode), and over HTTP tickets on `match-api.yyt.life` (`deferred` mode). Contract: `docs/decisions.md` §match service and §Match: deferred mode. A channel has one mode for life; each surface refuses a channel of the other.

- `src/app.ts` — Lambda entry points: REQUEST authorizer, `$connect`/`$disconnect`/`$default`, async `worker`, EventBridge `tick`.
- `src/pool.ts` — Redis ticket/queue state (key layout in `rules/data.md`).
- `src/matcher.ts` — `tryMatch`/`sweep`/`tick`, deadline-bounded; dispatches via `src/dispatch.ts` (signed callback).
- `src/tickets.ts` — deferred mode: the ticket routes (`http` function).
- `src/deferred.ts` — deferred mode: the state machine in Redis (waiting → proposed → confirmed), run by `worker` and `tick`.
- `src/push.ts` — deferred mode: the push hook (`SELECT` on `push_tokens`, FCM through `@yyt/push`).
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

## Deferred mode

For a game whose players do not wait with the app open. Base: the channel view's `apiBase` (`https://match-api.yyt.life`). Every request carries `Authorization: Bearer <auth JWT>` of the channel's auth channel, verified exactly as the socket's is; the player is the token's `sub`. CORS: any origin, no credentials. Every answer is `no-store`.

| Request                        | Answer                                                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /m/{channelId}/ticket`   | 200 ticket (`waiting`). A waiting ticket is replaced and goes to the back; 409 `proposed` while in a proposal; 409 `confirming` while the caller's last match is still being confirmed; 429 `queue_full`; 429 `cooldown` (`details.retryAfter` seconds) |
| `GET /m/{channelId}/ticket`    | 200 ticket; 404 when there is none                                                                                                                                                                                                                      |
| `DELETE /m/{channelId}/ticket` | 204, idempotent. During a proposal it counts as a decline; 409 `confirming` once everyone accepted                                                                                                                                                      |
| `POST /m/{channelId}/accept`   | 200 ticket, idempotent (also after `confirmed`); 404 no ticket; 409 `not_proposed`; 409 `proposal_closed` after `acceptBy` or after anyone declined                                                                                                     |
| `POST /m/{channelId}/decline`  | 200 ticket (`declined`), idempotent; 404 no ticket; 409 `not_proposed`, `proposal_closed` (also after `acceptBy`), `confirming` or `confirmed`                                                                                                          |

Errors are `{"error":{"code","message","details":{"reason"}}}`; the 409 and 429 reasons above are `details.reason`. Also 400 `wrong_mode` (a live channel), 401 (token), 403 (a `sub` that is not 1–128 printable ASCII characters), 404 (unknown channel; remembered for 10 s), 410 (channel or its auth channel inactive), 503 `busy` (retry). The token is checked before the channel's state: a caller without a valid token gets 401 for a disabled, expired or live channel, and only 404 (unknown id) and 410 (auth channel inactive) are answered without one. The API is throttled at 5 requests/s (burst 10) per stage, all channels together: poll `GET` no faster than every few seconds, or wait for the push.

A ticket is one of:

| `state`     | Body                                                    | Meaning                                                                                                                                                                                                |
| ----------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `waiting`   | `{state, position, waited}`                             | 1-based place in the queue; seconds since the ticket was first queued                                                                                                                                  |
| `proposed`  | `{state, matchId, acceptBy, accepted, partial}`         | `acceptBy` in unix seconds; `accepted` is the caller's own answer. Stays `proposed` until the match is confirmed                                                                                       |
| `confirmed` | `{state, matchId, partial, result, members:[{userId}]}` | the live mode's `matched` frame: `members` in ticket order, `result` the callback's JSON or `null`. Members only                                                                                       |
| `expired`   | `{state, reason: "wait"\|"accept", matchId?}`           | `wait`: `onTimeout: "fail"` ran out (live mode's `failed reason:"timeout"`); `accept`: the window closed unanswered                                                                                    |
| `declined`  | `{state, matchId}`                                      | the caller declined                                                                                                                                                                                    |
| `failed`    | `{state, reason: "callback"\|"closed", matchId?}`       | as live mode's `failed`. `closed` is written when the channel is disabled, expired or deleted, and the API answers 410/404 then: a client reads it only if the channel is re-enabled within 10 minutes |

`confirmed`, `expired`, `declined` and `failed` are readable for the channel's `resultTtlSec`, then the ticket is a 404. Any of them may be followed by a new `POST …/ticket`.

- **Accepting.** A proposal needs every member's accept by `acceptBy`. The last accept answers `proposed`; the confirmation (and the callback, called only now, with the live mode's signed body) follows within a moment — poll `GET`, or wait for the push.
- **A window that closes.** Members who accepted return to the queue with their original time, so ahead of anyone who queued later; the others read `expired reason:"accept"`. A new attempt runs at once. The schedule runs every minute, so a window may close up to a minute late; an accept or a decline that arrives after `acceptBy` is refused (`proposal_closed`) and closes it immediately, and a `DELETE` after `acceptBy` removes only the caller's ticket — in every case the others are judged by their own answers.
- **A decline** (or a `DELETE`) before `acceptBy` dissolves the proposal at once: everyone else returns to the queue, whether or not they had answered.
- **Cooldown.** A player who declined, deleted the ticket during a proposal, or did not accept before the window closed cannot submit to the channel for `acceptTimeoutSec`: 429 `cooldown`, `details.retryAfter` = seconds left. Members who accepted, or were sent back by someone else's decline, are not affected.
- **Wait timeout** counts the time a ticket spent waiting: time inside a proposal is not counted, so a member re-queued after a closed window or someone's decline is not expired (`fail`) or proposed short (`partial`) for it. `waited` and the queue order still count from the first submit. `partial` proposes whoever is present (possibly one player; it still needs the accept), `fail` expires the ticket.
- **Push** (optional, `pushChannelId`): a high-priority data-only FCM message `{channelId, matchId, state}` — all strings, `matchId` `""` when there is no match. `proposed` and `confirmed`/`failed` go to every member of the match; `expired` goes to everyone still in a proposal that closed or was declined (a re-queued member then reads `waiting`, or a new `proposed`) and to a ticket lost to the wait timeout. The message says to read `GET`; it is not the answer. `proposed`/`expired` messages to one user on one channel are at least 10 s apart (one batch sends only the latest; one inside the interval is dropped, not queued — the state is still there to read); `confirmed` and `failed` always go. Without a push channel, a registered device or a provisioned pool the mode works by polling.
- Bounds: 500 waiting tickets and 50 open proposals per channel. At 50 open proposals no new one forms, full party or partial: tickets keep waiting, and under `fail` their wait timeout keeps running, so a ticket can expire (`wait`) with a full party present.
- **Channel edits.** The console's `PATCH` replaces the whole config: a client must send `acceptTimeoutSec`, `resultTtlSec` and `pushChannelId` every time — an omitted one returns to its default, or is cleared. `mode` may be omitted and cannot change.

## Operations

- Functions: `authorizer` (5), `ws` (6), `http` (3, the ticket API), `worker` (2, 45s), `tick` (1, 60s, `rate(1 minute)`), `debug` (1, dev only) — 18 in all. Numbers are `reservedConcurrency`; each container holds one MySQL + one Redis connection.
- Deferred mode: a ticket route records what one player did under the channel lock and invokes `worker` with `{channelId, deferred: true}` — only when something changed, and at most once per 2 s per channel until a worker starts (`dkick:{channelId}`); `worker` and `tick` run every group transition (`deferred.ts` `run`) and are the only functions that call back or push. A fully accepted proposal is claimed (`confirming`) under the lock and confirmed outside it — only with 23 s of the function's time left (`ROUND_BUDGET_MS`: key read 5 s, callback 2 × 5 s, push 5 s, 3 s margin), the pushes after the callback; a claim nobody finished within 90 s is failed, or finished when its result was stored (`deferred claim abandoned`, an error line), never called back twice. `tick` returns the live summary plus `deferred: {channels, proposed, confirmed, expired, failed, skipped}`. Push outcomes are one counts-only `match push` line per send (`outcomes.spaced` = dropped by the 10 s interval).
- Deferred log lines to know: `deferred tick incomplete` (error) — the minute ran out before every active channel was visited; the walk is shuffled, so the next tick starts elsewhere, and accept/wait timeouts on the skipped channels are a minute later. `deferred pass lost its lock` (error) — a pass ran past 25 s of its 30 s lock or found the lock taken over, and stopped writing; the next pass continues. `deferred claim lost` (error) — a claimer found its claim replaced or nearly stale before the callback and sent nothing. The `http` function writes no per-request line; `request failed` (5xx) still logs.
- `/debug/tick` gives the deferred tick 8 s, so it proposes, dissolves and expires but never confirms: a confirmation, its callback and its pushes only come from `worker` (or the scheduled `tick`).
- **Deploy match before console** for the deferred mode too (`rules/deployment.md`): an older match bundle reads a deferred channel as live and would accept sockets on it, and the console would hand out a `ticketUrl` on a host that does not exist yet. Before rolling match back, disable every deferred channel.
- The match MySQL account needs `SELECT` on `push_tokens` for the push hook; without it every push is skipped (`match push failed`, `code: unavailable`) and matches are unaffected.
- `$connect` enqueues and invokes `worker` asynchronously (a socket cannot be posted to from inside its own `$connect`); the worker waits ≤6s for `GetConnection`, takes the per-channel lock (30s TTL, 4s wait; yields quietly when held) and dispatches while ≥12s remain. `tick` skips channels whose lock is held and logs `tick incomplete` when it runs out of time.
- Alarms (account-wide 10-alarm free-tier budget, `rules/serverless-aws.md`): `ws-errors` (both stages), `tick-errors` (prod only). Worker errors, throttles, the authorizer log metric and the message-count guard were removed on 2026-08-26; check those metrics by hand. Worker/tick have `maximumRetryAttempts: 0`; the next tick is the retry.
- Redis keys under `match:{stage}:` all carry TTLs; `result:{matchId}` (10 min) records who was dispatched and the outcome, never the callback payload.
- A channel without a `callbackUrl` makes no outbound request and reads no secret (`getMatchWithSecret` is skipped), so `failed reason:"callback"` cannot occur on it; the `result:{matchId}` record is written in both modes. `match dispatched` carries `mode: callback | members`, which is what a "the match landed and nothing happened" report is filtered on — in the members-only mode the room is formed entirely by the clients, so the stack's last word is that line.
- **Deploy match before console** when the optional-callback bundle rolls out to a stage (`rules/deployment.md`): a console that can already store a config without the key, in front of a match that still expects one, fails every match on such a channel with `failed:callback`.
- Changing the mode is subject to the same 60 s config cache as every other config edit: for up to a minute after clearing a `callbackUrl` the stack still POSTs to it, and for up to a minute after setting one clients still get `result:null`. Wait it out before concluding the edit did not take.
- Channel config is cached 60s, so disabling a channel takes effect within a minute.
