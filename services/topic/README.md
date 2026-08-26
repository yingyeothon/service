# @yyt/service-topic

`topic.yyt.life` (HTTP control API) + `topic-ws.yyt.life` (WebSocket) — short-lived broadcast topics. Contract: `docs/decisions.md` §topic service. The two hostnames exist because API Gateway cannot map an HTTP API and a WebSocket API onto one custom domain; clients only ever use the `wsUrl` returned by `POST /t`.

- `src/app.ts` — REQUEST authorizer, `$connect`/`$disconnect`/`$default`, `broadcast` (prunes dead sockets).
- `src/http.ts` — `POST /t`, `GET|DELETE /t/{id}`, `POST /t/{id}/publish` (Bearer = channel apiKey).
- `src/topics.ts` — Redis state (key layout in `rules/data.md`); every key carries the topic's TTL.
- `src/channels.ts` — topic channel config (cached 60s without the apiKey), apiKey → channel lookup, linked auth channel verifier.

## HTTP (`Authorization: Bearer <apiKey>`)

| Route                  | Body / result                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `POST /t`              | `{allowUserIds?: string[], ttlSec?: 1..1200}` → `201 {topicId, wsUrl, expiresAt}`        |
| `GET /t/{id}`          | `{topicId, channelId, allowUserIds, createdAt, expiresAt, wsUrl, connections}`           |
| `DELETE /t/{id}`       | broadcasts `{type:"closed"}`, drops every socket, removes the topic → `204`              |
| `POST /t/{id}/publish` | `{payload}` (≤16 KB) → `{seq, delivered}`; members receive `{type:"msg", from:"server"}` |

A topic of another channel answers `404`; a missing/unknown/disabled apiKey answers `401`.

## WebSocket

Connect to `wss://topic-ws.yyt.life/?topic={topicId}` with `Sec-WebSocket-Protocol: bearer, <auth JWT>` (issued by the channel's linked auth channel). When the topic has `allowUserIds`, the JWT's `sub` must be listed.

| Direction | Message                                              | Note                                                                    |
| --------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| client →  | `{"type":"msg","payload":any}`                       | body ≤16 KB                                                             |
| client →  | `{"type":"ping"}`                                    | → `{"type":"pong"}`                                                     |
| ← server  | `{"type":"msg","from":userId,"seq":n,"payload"}`     | fan-out to everyone **including the sender**; `seq` increases per topic |
| ← server  | `{"type":"join"\|"leave","userId"}`                  | membership changes (the joiner does not receive its own `join`)         |
| ← server  | `{"type":"error","code":"too_large"\|"bad_message"}` | the message was not delivered                                           |
| ← server  | `{"type":"expired"}`                                 | topic TTL elapsed or topic deleted; the client should close             |
| ← server  | `{"type":"closed"}`                                  | `DELETE /t/{id}`; the server then drops the socket (best effort)        |

The server never closes sockets on expiry (closing right after a post loses the frame); idle sockets expire after 10 minutes.

## Operations

- Functions: `authorizer` (4), `ws` (5), `http` (3). Numbers are `reservedConcurrency`; each container holds one MySQL + one Redis connection.
- A 410 on post from a socket registered <10s ago (`PENDING_GRACE_SEC`) is treated as a pending handshake, not as a dead socket; older 410s prune the connection and announce `leave`.
- Each topic holds at most 256 connections (`MAX_CONNS`; `$connect` answers 429 above it) and a topic's TTL is clamped to its channel's remaining lifetime.
- Alarms (account-wide 10-alarm free-tier budget, `rules/serverless-aws.md`): `ws-errors` (both stages), `authorize-errors` (prod only; log metric on `"m":"authorize error"` — Redis/MySQL unreachable from the authorizer, which otherwise only denies). HTTP errors, throttles (`reservedConcurrency` is small, so a throttle drops messages silently — check `Throttles` by hand), authorizer Lambda errors and the message-count guard were removed on 2026-08-26.
- Channel config is cached 60s; the apiKey lookup scans the topic channels of the stage (no index on the secret) and compares hashes in constant time.
